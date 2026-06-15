const express = require('express');
const db = require('../db');
const { authMiddleware, adminMiddleware, issuerMiddleware } = require('../middleware/auth');
const { changeHeadphoneStatus } = require('./headphones');

const router = express.Router();

function generateBatchNo() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const count = db.prepare('SELECT COUNT(*) as cnt FROM borrow_batches WHERE batch_no LIKE ?').get(`B${ymd}%`).cnt;
  return `B${ymd}${String(count + 1).padStart(3, '0')}`;
}

router.get('/', authMiddleware, issuerMiddleware, (req, res) => {
  try {
    const { is_active, start_date, end_date, page, page_size } = req.query;
    let sql = `
      SELECT bb.*, u.username as issuer_name, u.real_name as issuer_real_name,
        (SELECT COUNT(*) FROM borrow_records br WHERE br.batch_id = bb.id) as total_count,
        (SELECT COUNT(*) FROM borrow_records br WHERE br.batch_id = bb.id AND br.returned_at IS NULL) as unreturned_count,
        (SELECT COUNT(*) FROM collection_followups cf WHERE cf.batch_id = bb.id) as followup_count,
        (SELECT cf.collected_at FROM collection_followups cf WHERE cf.batch_id = bb.id ORDER BY cf.collected_at DESC LIMIT 1) as last_followup_at,
        (SELECT uu.real_name FROM collection_followups cf LEFT JOIN users uu ON cf.collected_by = uu.id WHERE cf.batch_id = bb.id ORDER BY cf.collected_at DESC LIMIT 1) as last_followup_by,
        (SELECT cf.communication_method FROM collection_followups cf WHERE cf.batch_id = bb.id ORDER BY cf.collected_at DESC LIMIT 1) as last_followup_method,
        (SELECT cf.remark FROM collection_followups cf WHERE cf.batch_id = bb.id ORDER BY cf.collected_at DESC LIMIT 1) as last_followup_remark,
        (SELECT cf.expected_return_date FROM collection_followups cf WHERE cf.batch_id = bb.id ORDER BY cf.collected_at DESC LIMIT 1) as last_expected_return
      FROM borrow_batches bb
      LEFT JOIN users u ON bb.issuer_id = u.id
      WHERE 1=1
    `;
    const params = [];
    if (is_active !== undefined) {
      sql += ' AND bb.is_active = ?';
      params.push(is_active === 'true' || is_active === '1' ? 1 : 0);
    }
    if (start_date) {
      sql += ' AND DATE(bb.created_at) >= ?';
      params.push(start_date);
    }
    if (end_date) {
      sql += ' AND DATE(bb.created_at) <= ?';
      params.push(end_date);
    }
    sql += ' ORDER BY bb.created_at DESC';

    let countSql = 'SELECT COUNT(*) as total FROM borrow_batches bb WHERE 1=1';
    const countParams = [];
    if (is_active !== undefined) {
      countSql += ' AND bb.is_active = ?';
      countParams.push(is_active === 'true' || is_active === '1' ? 1 : 0);
    }
    if (start_date) {
      countSql += ' AND DATE(bb.created_at) >= ?';
      countParams.push(start_date);
    }
    if (end_date) {
      countSql += ' AND DATE(bb.created_at) <= ?';
      countParams.push(end_date);
    }
    const total = db.prepare(countSql).get(...countParams).total;

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

router.get('/:id', authMiddleware, issuerMiddleware, (req, res) => {
  try {
    const bb = db.prepare(`
      SELECT bb.*, u.username as issuer_name, u.real_name as issuer_real_name,
        (SELECT COUNT(*) FROM collection_followups cf WHERE cf.batch_id = bb.id) as followup_count
      FROM borrow_batches bb
      LEFT JOIN users u ON bb.issuer_id = u.id
      WHERE bb.id = ?
    `).get(req.params.id);
    if (!bb) {
      return res.status(404).json({ error: '批次不存在' });
    }
    const records = db.prepare(`
      SELECT br.*, h.serial_no, h.content_version,
        ui.username as issuer_name, ur.username as returner_name, urv.username as reviewer_name
      FROM borrow_records br
      JOIN headphones h ON br.headphone_id = h.id
      LEFT JOIN users ui ON br.issued_by = ui.id
      LEFT JOIN users ur ON br.returned_by = ur.id
      LEFT JOIN users urv ON br.reviewed_by = urv.id
      WHERE br.batch_id = ?
      ORDER BY br.issued_at DESC
    `).all(req.params.id);
    const followups = db.prepare(`
      SELECT cf.*, u.username as collector_name, u.real_name as collector_real_name
      FROM collection_followups cf
      LEFT JOIN users u ON cf.collected_by = u.id
      WHERE cf.batch_id = ?
      ORDER BY cf.collected_at DESC
    `).all(req.params.id);
    res.json({ ...bb, records, followups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', authMiddleware, issuerMiddleware, (req, res) => {
  try {
    const { purpose, expected_return_date, headphone_ids } = req.body;
    const batchNo = generateBatchNo();

    const tx = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO borrow_batches (batch_no, issuer_id, purpose, expected_return_date)
        VALUES (?, ?, ?, ?)
      `).run(batchNo, req.user.id, purpose || null, expected_return_date || null);
      const batchId = result.lastInsertRowid;

      if (headphone_ids && Array.isArray(headphone_ids) && headphone_ids.length > 0) {
        const insertRecord = db.prepare(`
          INSERT INTO borrow_records (headphone_id, batch_id, issued_by, content_version_issued)
          VALUES (?, ?, ?, ?)
        `);
        const updateHp = db.prepare(`
          UPDATE headphones
          SET status = '使用中', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `);
        const insertHistory = db.prepare(`
          INSERT INTO status_history (headphone_id, from_status, to_status, changed_by, remark)
          VALUES (?, ?, ?, ?, ?)
        `);

        for (const hpId of headphone_ids) {
          const hp = db.prepare('SELECT * FROM headphones WHERE id = ?').get(hpId);
          if (!hp) {
            throw new Error(`耳机 ID ${hpId} 不存在`);
          }
          if (hp.needs_review === 1) {
            throw new Error(`耳机 ${hp.serial_no} 需要先复核后才能发出`);
          }
          const inActive = db.prepare(`
            SELECT br.id FROM borrow_records br
            JOIN borrow_batches bb ON br.batch_id = bb.id
            WHERE br.headphone_id = ? AND bb.is_active = 1 AND br.returned_at IS NULL
          `).get(hpId);
          if (inActive) {
            throw new Error(`耳机 ${hp.serial_no} 已在其他活跃批次中`);
          }
          if (!['待发出', '恢复可用'].includes(hp.status)) {
            throw new Error(`耳机 ${hp.serial_no} 当前状态(${hp.status})不可发出`);
          }
          insertRecord.run(hpId, batchId, req.user.id, hp.content_version);
          updateHp.run(hpId);
          insertHistory.run(hpId, hp.status, '使用中', req.user.id, `批次 ${batchNo} 发放`);
        }
      }
      return batchId;
    });

    const batchId = tx();
    const bb = db.prepare(`
      SELECT bb.*, u.username as issuer_name, u.real_name as issuer_real_name
      FROM borrow_batches bb
      LEFT JOIN users u ON bb.issuer_id = u.id
      WHERE bb.id = ?
    `).get(batchId);
    res.status(201).json(bb);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/add-headphones', authMiddleware, issuerMiddleware, (req, res) => {
  try {
    const { headphone_ids } = req.body;
    if (!headphone_ids || !Array.isArray(headphone_ids) || headphone_ids.length === 0) {
      return res.status(400).json({ error: '耳机ID列表不能为空' });
    }
    const bb = db.prepare('SELECT * FROM borrow_batches WHERE id = ?').get(req.params.id);
    if (!bb) {
      return res.status(404).json({ error: '批次不存在' });
    }
    if (bb.is_active === 0) {
      return res.status(400).json({ error: '批次已关闭，不能添加耳机' });
    }

    const tx = db.transaction(() => {
      const insertRecord = db.prepare(`
        INSERT INTO borrow_records (headphone_id, batch_id, issued_by, content_version_issued)
        VALUES (?, ?, ?, ?)
      `);
      const updateHp = db.prepare(`
        UPDATE headphones
        SET status = '使用中', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      const insertHistory = db.prepare(`
        INSERT INTO status_history (headphone_id, from_status, to_status, changed_by, remark)
        VALUES (?, ?, ?, ?, ?)
      `);

      for (const hpId of headphone_ids) {
        const hp = db.prepare('SELECT * FROM headphones WHERE id = ?').get(hpId);
        if (!hp) {
          throw new Error(`耳机 ID ${hpId} 不存在`);
        }
        if (hp.needs_review === 1) {
          throw new Error(`耳机 ${hp.serial_no} 需要先复核后才能发出`);
        }
        const inActive = db.prepare(`
          SELECT br.id FROM borrow_records br
          JOIN borrow_batches bb ON br.batch_id = bb.id
          WHERE br.headphone_id = ? AND bb.is_active = 1 AND br.returned_at IS NULL
        `).get(hpId);
        if (inActive) {
          throw new Error(`耳机 ${hp.serial_no} 已在其他活跃批次中`);
        }
        if (!['待发出', '恢复可用'].includes(hp.status)) {
          throw new Error(`耳机 ${hp.serial_no} 当前状态(${hp.status})不可发出`);
        }
        insertRecord.run(hpId, bb.id, req.user.id, hp.content_version);
        updateHp.run(hpId);
        insertHistory.run(hpId, hp.status, '使用中', req.user.id, `批次 ${bb.batch_no} 发放`);
      }
    });
    tx();

    res.json({ message: '耳机已加入批次' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/close', authMiddleware, issuerMiddleware, (req, res) => {
  try {
    const bb = db.prepare('SELECT * FROM borrow_batches WHERE id = ?').get(req.params.id);
    if (!bb) {
      return res.status(404).json({ error: '批次不存在' });
    }
    const unreturned = db.prepare(`
      SELECT COUNT(*) as cnt FROM borrow_records
      WHERE batch_id = ? AND returned_at IS NULL
    `).get(req.params.id).cnt;
    if (unreturned > 0) {
      return res.status(400).json({ error: `批次中仍有 ${unreturned} 个耳机未归还` });
    }
    db.prepare('UPDATE borrow_batches SET is_active = 0 WHERE id = ?').run(req.params.id);
    const updated = db.prepare(`
      SELECT bb.*, u.username as issuer_name, u.real_name as issuer_real_name
      FROM borrow_batches bb
      LEFT JOIN users u ON bb.issuer_id = u.id
      WHERE bb.id = ?
    `).get(req.params.id);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/followups', authMiddleware, issuerMiddleware, (req, res) => {
  try {
    const bb = db.prepare('SELECT id FROM borrow_batches WHERE id = ?').get(req.params.id);
    if (!bb) {
      return res.status(404).json({ error: '批次不存在' });
    }
    const followups = db.prepare(`
      SELECT cf.*, u.username as collector_name, u.real_name as collector_real_name
      FROM collection_followups cf
      LEFT JOIN users u ON cf.collected_by = u.id
      WHERE cf.batch_id = ?
      ORDER BY cf.collected_at DESC
    `).all(req.params.id);
    res.json({ total: followups.length, items: followups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/followups', authMiddleware, issuerMiddleware, (req, res) => {
  try {
    const bb = db.prepare('SELECT * FROM borrow_batches WHERE id = ?').get(req.params.id);
    if (!bb) {
      return res.status(404).json({ error: '批次不存在' });
    }
    if (bb.is_active === 0) {
      return res.status(400).json({ error: '批次已关闭，不能进行催还登记' });
    }
    const unreturned = db.prepare(`
      SELECT COUNT(*) as cnt FROM borrow_records
      WHERE batch_id = ? AND returned_at IS NULL
    `).get(req.params.id).cnt;
    if (unreturned === 0) {
      return res.status(400).json({ error: '该批次所有耳机已归还，无需催还' });
    }

    const nearDue = db.prepare(`
      SELECT
        CASE
          WHEN ? IS NOT NULL THEN
            CASE WHEN JULIANDAY(DATE(?)) - JULIANDAY(DATE(CURRENT_TIMESTAMP)) <= 2 THEN 1 ELSE 0 END
          ELSE
            CASE WHEN (JULIANDAY(CURRENT_TIMESTAMP) - JULIANDAY(MIN(issued_at))) > 1 THEN 1 ELSE 0 END
        END as is_near_due
      FROM borrow_records
      WHERE batch_id = ? AND returned_at IS NULL
    `).get(bb.expected_return_date, bb.expected_return_date, req.params.id);

    if (!nearDue || nearDue.is_near_due !== 1) {
      const msg = bb.expected_return_date
        ? `距离期望归还日（${bb.expected_return_date}）超过2天，暂无需催还`
        : '批次发出不足1天，暂无需催还';
      return res.status(400).json({ error: msg });
    }

    const { communication_method, remark, expected_return_date } = req.body;
    if (!communication_method) {
      return res.status(400).json({ error: '沟通方式不能为空' });
    }
    const validMethods = ['电话', '微信', '短信', '邮件', '当面', '其他'];
    if (!validMethods.includes(communication_method)) {
      return res.status(400).json({ error: `沟通方式必须是：${validMethods.join('、')}` });
    }

    const result = db.prepare(`
      INSERT INTO collection_followups (batch_id, collected_by, communication_method, remark, expected_return_date)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      req.params.id,
      req.user.id,
      communication_method,
      remark || null,
      expected_return_date || null
    );

    const followup = db.prepare(`
      SELECT cf.*, u.username as collector_name, u.real_name as collector_real_name
      FROM collection_followups cf
      LEFT JOIN users u ON cf.collected_by = u.id
      WHERE cf.id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json(followup);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const bb = db.prepare('SELECT * FROM borrow_batches WHERE id = ?').get(req.params.id);
    if (!bb) {
      return res.status(404).json({ error: '批次不存在' });
    }
    const hasRecords = db.prepare('SELECT COUNT(*) as cnt FROM borrow_records WHERE batch_id = ?').get(req.params.id).cnt;
    if (hasRecords > 0) {
      return res.status(400).json({ error: '批次中存在借用记录，无法删除' });
    }
    db.prepare('DELETE FROM borrow_batches WHERE id = ?').run(req.params.id);
    res.json({ message: '删除成功' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
