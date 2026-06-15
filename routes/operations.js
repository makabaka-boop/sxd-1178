const express = require('express');
const db = require('../db');
const { authMiddleware, issuerMiddleware, adminMiddleware } = require('../middleware/auth');

const router = express.Router();

function addAlert(type, severity, message, details, headphoneId, batchId, userId) {
  db.prepare(`
    INSERT INTO alerts (alert_type, severity, message, details, headphone_id, batch_id, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(type, severity, message, details || null, headphoneId || null, batchId || null, userId || null);
}

router.post('/return/:record_id', authMiddleware, issuerMiddleware, (req, res) => {
  try {
    const {
      audition_result, battery_level_return, earpad_condition,
      content_issue, content_version_return
    } = req.body;

    const record = db.prepare('SELECT * FROM borrow_records WHERE id = ?').get(req.params.record_id);
    if (!record) {
      return res.status(404).json({ error: '借用记录不存在' });
    }
    if (record.returned_at) {
      return res.status(400).json({ error: '该耳机已归还' });
    }
    const hp = db.prepare('SELECT * FROM headphones WHERE id = ?').get(record.headphone_id);
    if (!hp) {
      return res.status(404).json({ error: '耳机不存在' });
    }

    const tx = db.transaction(() => {
      const contentMismatch = content_version_return &&
        record.content_version_issued &&
        content_version_return !== record.content_version_issued;

      db.prepare(`
        UPDATE borrow_records
        SET returned_at = CURRENT_TIMESTAMP,
            returned_by = ?,
            audition_result = ?,
            battery_level_return = ?,
            earpad_condition = ?,
            content_issue = ?,
            content_version_return = ?
        WHERE id = ?
      `).run(
        req.user.id,
        audition_result || null,
        battery_level_return !== undefined ? battery_level_return : null,
        earpad_condition || null,
        content_issue || null,
        content_version_return || null,
        req.params.record_id
      );

      let nextStatus;
      let needsReview = 0;
      const disposalTypes = [];

      if (contentMismatch) {
        disposalTypes.push('版本不一致');
      }
      if (audition_result === '异常') {
        disposalTypes.push('试听异常');
      }
      if (earpad_condition === '损坏' || earpad_condition === '磨损严重') {
        disposalTypes.push('耳罩损坏');
      }
      if (battery_level_return !== undefined && battery_level_return < 50) {
        disposalTypes.push('低电量');
      }
      if (content_issue) {
        disposalTypes.push('内容问题');
      }

      if (disposalTypes.length > 0) {
        nextStatus = '待复核';
        needsReview = 1;
        db.prepare(`
          UPDATE borrow_records
          SET disposal_status = '待处置'
          WHERE id = ?
        `).run(req.params.record_id);

        const insertDisposal = db.prepare(`
          INSERT INTO disposal_records (borrow_record_id, headphone_id, batch_id, disposal_type, disposal_status, result_status)
          VALUES (?, ?, ?, ?, '待处置', '待复核')
        `);
        for (const dtype of disposalTypes) {
          insertDisposal.run(req.params.record_id, record.headphone_id, record.batch_id, dtype);
        }
      } else if (battery_level_return !== undefined && battery_level_return < 50) {
        nextStatus = '待回收核对';
      } else {
        nextStatus = '待回收核对';
      }

      db.prepare(`
        UPDATE headphones
        SET status = ?, battery_level = ?, needs_review = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(nextStatus, battery_level_return ?? hp.battery_level, needsReview, record.headphone_id);

      db.prepare(`
        INSERT INTO status_history (headphone_id, from_status, to_status, changed_by, remark)
        VALUES (?, ?, ?, ?, ?)
      `).run(record.headphone_id, '使用中', nextStatus, req.user.id,
        disposalTypes.length > 0
          ? `回收登记，异常类型：${disposalTypes.join('、')}`
          : '回收登记'
      );

      if (contentMismatch) {
        addAlert(
          'VERSION_MISMATCH',
          'high',
          `耳机 ${hp.serial_no} 发出版本与归还版本不一致`,
          `发出: ${record.content_version_issued}, 归还: ${content_version_return}`,
          hp.id,
          record.batch_id,
          null
        );
      }

      if (audition_result === '异常') {
        const recordsOfOwner = db.prepare(`
          SELECT br.id
          FROM borrow_records br
          JOIN headphones h ON br.headphone_id = h.id
          WHERE h.responsible_person = ?
            AND br.audition_result = '异常'
            AND br.id != ?
          ORDER BY br.issued_at DESC
          LIMIT 2
        `).all(hp.responsible_person, record.id);
        if (recordsOfOwner.length >= 2) {
          addAlert(
            'OWNER_CONSECUTIVE_ABNORMAL',
            'medium',
            `责任人 ${hp.responsible_person} 名下连续出现试听异常`,
            `耳机 ${hp.serial_no} 等连续 3 次试听异常`,
            hp.id,
            null,
            null
          );
        }
      }
    });
    tx();

    const updated = db.prepare(`
      SELECT br.*, h.serial_no, h.content_version, h.status as current_status,
        ui.username as issuer_name, ur.username as returner_name
      FROM borrow_records br
      JOIN headphones h ON br.headphone_id = h.id
      LEFT JOIN users ui ON br.issued_by = ui.id
      LEFT JOIN users ur ON br.returned_by = ur.id
      WHERE br.id = ?
    `).get(req.params.record_id);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/review/:record_id', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const {
      review_remark, disposal_conclusion, disposal_liability, disposal_remark
    } = req.body;
    const record = db.prepare('SELECT * FROM borrow_records WHERE id = ?').get(req.params.record_id);
    if (!record) {
      return res.status(404).json({ error: '借用记录不存在' });
    }
    if (!record.returned_at) {
      return res.status(400).json({ error: '耳机尚未归还，不能复核' });
    }
    if (record.reviewed_at) {
      return res.status(400).json({ error: '该记录已复核' });
    }
    const hp = db.prepare('SELECT * FROM headphones WHERE id = ?').get(record.headphone_id);
    if (!hp) {
      return res.status(404).json({ error: '耳机不存在' });
    }

    const validConclusions = ['恢复可用', '待充电', '停用观察', '返厂维修', '报废'];
    if (disposal_conclusion && !validConclusions.includes(disposal_conclusion)) {
      return res.status(400).json({ error: `处置结论必须是：${validConclusions.join('、')}` });
    }

    let nextStatus;
    if (disposal_conclusion) {
      if (['恢复可用'].includes(disposal_conclusion)) {
        nextStatus = '恢复可用';
      } else if (['待充电'].includes(disposal_conclusion)) {
        nextStatus = '待充电';
      } else if (['停用观察', '返厂维修', '报废'].includes(disposal_conclusion)) {
        nextStatus = '停用观察';
      }
    } else {
      if ((record.battery_level_return ?? 100) < 50) {
        nextStatus = '待充电';
      } else {
        nextStatus = '恢复可用';
      }
    }

    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE borrow_records
        SET reviewed_at = CURRENT_TIMESTAMP,
            reviewed_by = ?,
            review_remark = ?,
            disposal_status = '已处置',
            disposal_conclusion = ?,
            disposal_liability = ?,
            disposal_remark = ?,
            disposed_by = ?,
            disposed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        req.user.id,
        review_remark || null,
        disposal_conclusion || null,
        disposal_liability || null,
        disposal_remark || null,
        req.user.id,
        req.params.record_id
      );

      db.prepare(`
        UPDATE headphones
        SET status = ?, needs_review = 0, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(nextStatus, record.headphone_id);

      db.prepare(`
        INSERT INTO status_history (headphone_id, from_status, to_status, changed_by, remark)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        record.headphone_id,
        hp.status,
        nextStatus,
        req.user.id,
        disposal_conclusion
          ? `复核完成，处置结论：${disposal_conclusion}${disposal_liability ? '，责任归属：' + disposal_liability : ''}${disposal_remark ? '，备注：' + disposal_remark : ''}`
          : '复核完成'
      );

      const pendingDisposals = db.prepare(`
        SELECT id FROM disposal_records
        WHERE borrow_record_id = ? AND disposal_status != '已处置'
      `).all(req.params.record_id);

      const updateDisposal = db.prepare(`
        UPDATE disposal_records
        SET disposal_status = '已处置',
            disposal_conclusion = ?,
            disposal_liability = ?,
            disposal_remark = ?,
            result_status = ?,
            handled_by = ?,
            handled_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);

      for (const d of pendingDisposals) {
        updateDisposal.run(
          disposal_conclusion || (nextStatus === '待充电' ? '待充电' : '恢复可用'),
          disposal_liability || null,
          disposal_remark || null,
          nextStatus,
          req.user.id,
          d.id
        );
      }
    });
    tx();

    const updated = db.prepare(`
      SELECT br.*, h.serial_no, h.content_version, h.status as current_status,
        urv.username as reviewer_name
      FROM borrow_records br
      JOIN headphones h ON br.headphone_id = h.id
      LEFT JOIN users urv ON br.reviewed_by = urv.id
      WHERE br.id = ?
    `).get(req.params.record_id);

    const disposalRecords = db.prepare(`
      SELECT * FROM disposal_records WHERE borrow_record_id = ?
    `).all(req.params.record_id);

    res.json({
      message: `复核完成，耳机状态已更新为「${nextStatus}」`,
      record: updated,
      disposal_records: disposalRecords,
      disposal_conclusion: disposal_conclusion || null,
      disposal_liability: disposal_liability || null,
      next_status: nextStatus
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/check-recycle', authMiddleware, issuerMiddleware, (req, res) => {
  try {
    const { headphone_ids, battery_levels } = req.body;
    if (!headphone_ids || !Array.isArray(headphone_ids)) {
      return res.status(400).json({ error: '耳机ID列表不能为空' });
    }
    const tx = db.transaction(() => {
      for (let i = 0; i < headphone_ids.length; i++) {
        const hpId = headphone_ids[i];
        const hp = db.prepare('SELECT * FROM headphones WHERE id = ?').get(hpId);
        if (!hp) continue;
        if (hp.status !== '待回收核对') continue;

        const batLevel = battery_levels && battery_levels[i] !== undefined
          ? battery_levels[i]
          : hp.battery_level;

        let nextStatus;
        if (batLevel < 50) {
          nextStatus = '待充电';
        } else {
          nextStatus = hp.needs_review === 1 ? '待复核' : '恢复可用';
        }

        db.prepare(`
          UPDATE headphones
          SET status = ?, battery_level = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(nextStatus, batLevel, hpId);

        db.prepare(`
          INSERT INTO status_history (headphone_id, from_status, to_status, changed_by, remark)
          VALUES (?, ?, ?, ?, ?)
        `).run(hpId, '待回收核对', nextStatus, req.user.id, '回收核对完成');
      }
    });
    tx();
    res.json({ message: '回收核对完成' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/active', authMiddleware, issuerMiddleware, (req, res) => {
  try {
    const records = db.prepare(`
      SELECT br.*, h.serial_no, h.content_version, h.cabinet_position, h.responsible_person,
        bb.batch_no, bb.purpose,
        ui.username as issuer_name, ui.real_name as issuer_real_name
      FROM borrow_records br
      JOIN headphones h ON br.headphone_id = h.id
      JOIN borrow_batches bb ON br.batch_id = bb.id
      LEFT JOIN users ui ON br.issued_by = ui.id
      WHERE br.returned_at IS NULL
        AND bb.is_active = 1
      ORDER BY br.issued_at DESC
    `).all();
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

router.get('/disposal-records', authMiddleware, issuerMiddleware, (req, res) => {
  try {
    const { disposal_status, disposal_type, headphone_id, batch_id, page, page_size } = req.query;
    let sql = `
      SELECT dr.*, h.serial_no, h.content_version, h.status as headphone_status,
        bb.batch_no,
        u.username as handler_name, u.real_name as handler_real_name
      FROM disposal_records dr
      JOIN headphones h ON dr.headphone_id = h.id
      LEFT JOIN borrow_batches bb ON dr.batch_id = bb.id
      LEFT JOIN users u ON dr.handled_by = u.id
      WHERE 1=1
    `;
    const params = [];
    if (disposal_status) {
      sql += ' AND dr.disposal_status = ?';
      params.push(disposal_status);
    }
    if (disposal_type) {
      sql += ' AND dr.disposal_type = ?';
      params.push(disposal_type);
    }
    if (headphone_id) {
      sql += ' AND dr.headphone_id = ?';
      params.push(headphone_id);
    }
    if (batch_id) {
      sql += ' AND dr.batch_id = ?';
      params.push(batch_id);
    }
    sql += ' ORDER BY dr.created_at DESC';

    const countSql = sql.replace(/SELECT dr\.\*, h\.serial_no.*?WHERE 1=1/, 'SELECT COUNT(*) as total FROM disposal_records dr WHERE 1=1');
    const countParams = [];
    if (disposal_status) {
      countParams.push(disposal_status);
    }
    if (disposal_type) {
      countParams.push(disposal_type);
    }
    if (headphone_id) {
      countParams.push(headphone_id);
    }
    if (batch_id) {
      countParams.push(batch_id);
    }

    let total = 0;
    try {
      total = db.prepare(countSql).get(...countParams).total;
    } catch (e) {
      const allItems = db.prepare(sql).all(...params);
      total = allItems.length;
    }

    const pg = Math.max(1, Number(page) || 1);
    const ps = Math.min(100, Math.max(1, Number(page_size) || 20));
    sql += ' LIMIT ? OFFSET ?';
    params.push(ps, (pg - 1) * ps);

    const items = db.prepare(sql).all(...params);
    res.json({
      items,
      total,
      page: pg,
      page_size: ps,
      total_pages: Math.ceil(total / ps)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/disposal/:disposal_id/handle', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { disposal_conclusion, disposal_liability, disposal_remark, result_status } = req.body;
    const disposal = db.prepare('SELECT * FROM disposal_records WHERE id = ?').get(req.params.disposal_id);
    if (!disposal) {
      return res.status(404).json({ error: '处置记录不存在' });
    }
    if (disposal.disposal_status === '已处置') {
      return res.status(400).json({ error: '该处置记录已处理' });
    }

    const validConclusions = ['恢复可用', '待充电', '停用观察', '返厂维修', '报废'];
    if (disposal_conclusion && !validConclusions.includes(disposal_conclusion)) {
      return res.status(400).json({ error: `处置结论必须是：${validConclusions.join('、')}` });
    }
    const validResultStatuses = ['恢复可用', '待充电', '停用观察'];
    const finalResultStatus = result_status || (disposal_conclusion === '恢复可用' ? '恢复可用' : (disposal_conclusion === '待充电' ? '待充电' : '停用观察'));
    if (!validResultStatuses.includes(finalResultStatus)) {
      return res.status(400).json({ error: `结果状态必须是：${validResultStatuses.join('、')}` });
    }

    const hp = db.prepare('SELECT * FROM headphones WHERE id = ?').get(disposal.headphone_id);

    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE disposal_records
        SET disposal_status = '已处置',
            disposal_conclusion = ?,
            disposal_liability = ?,
            disposal_remark = ?,
            result_status = ?,
            handled_by = ?,
            handled_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        disposal_conclusion || null,
        disposal_liability || null,
        disposal_remark || null,
        finalResultStatus,
        req.user.id,
        req.params.disposal_id
      );

      const remainingPending = db.prepare(`
        SELECT COUNT(*) as cnt FROM disposal_records
        WHERE borrow_record_id = ? AND disposal_status != '已处置'
      `).get(disposal.borrow_record_id).cnt;

      if (remainingPending === 0) {
        db.prepare(`
          UPDATE borrow_records
          SET disposal_status = '已处置',
              disposal_conclusion = ?,
              disposal_liability = ?,
              disposal_remark = ?,
              disposed_by = ?,
              disposed_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(
          disposal_conclusion || null,
          disposal_liability || null,
          disposal_remark || null,
          req.user.id,
          disposal.borrow_record_id
        );
      } else {
        db.prepare(`
          UPDATE borrow_records
          SET disposal_status = '处置中'
          WHERE id = ? AND disposal_status = '待处置'
        `).run(disposal.borrow_record_id);
      }

      if (hp && ['待复核'].includes(hp.status)) {
        db.prepare(`
          UPDATE headphones
          SET status = ?, needs_review = 0, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(finalResultStatus, disposal.headphone_id);

        db.prepare(`
          INSERT INTO status_history (headphone_id, from_status, to_status, changed_by, remark)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          disposal.headphone_id,
          hp.status,
          finalResultStatus,
          req.user.id,
          `处置完成：${disposal_conclusion || '无结论'}${disposal_liability ? '，责任：' + disposal_liability : ''}${disposal_remark ? '，备注：' + disposal_remark : ''}`
        );
      }
    });
    tx();

    const updated = db.prepare(`
      SELECT dr.*, h.serial_no, h.status as headphone_status,
        u.username as handler_name, u.real_name as handler_real_name
      FROM disposal_records dr
      JOIN headphones h ON dr.headphone_id = h.id
      LEFT JOIN users u ON dr.handled_by = u.id
      WHERE dr.id = ?
    `).get(req.params.disposal_id);

    res.json({
      message: '处置完成',
      disposal_record: updated,
      result_status: finalResultStatus
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
