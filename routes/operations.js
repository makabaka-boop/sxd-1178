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
      if (content_issue || contentMismatch) {
        nextStatus = '待复核';
        needsReview = 1;
      } else if (battery_level_return !== undefined && battery_level_return < 50) {
        nextStatus = '待回收核对';
      } else if (audition_result === '异常') {
        nextStatus = '待复核';
        needsReview = 1;
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
      `).run(record.headphone_id, '使用中', nextStatus, req.user.id, '回收登记');

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
    const { review_remark } = req.body;
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

    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE borrow_records
        SET reviewed_at = CURRENT_TIMESTAMP,
            reviewed_by = ?,
            review_remark = ?
        WHERE id = ?
      `).run(req.user.id, review_remark || null, req.params.record_id);

      let nextStatus;
      if ((record.battery_level_return ?? 100) < 50) {
        nextStatus = '待充电';
      } else {
        nextStatus = '恢复可用';
      }

      db.prepare(`
        UPDATE headphones
        SET status = ?, needs_review = 0, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(nextStatus, record.headphone_id);

      db.prepare(`
        INSERT INTO status_history (headphone_id, from_status, to_status, changed_by, remark)
        VALUES (?, ?, ?, ?, ?)
      `).run(record.headphone_id, hp.status, nextStatus, req.user.id, '复核完成');
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
    res.json(updated);
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
