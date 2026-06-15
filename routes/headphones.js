const express = require('express');
const db = require('../db');
const { authMiddleware, adminMiddleware, issuerMiddleware } = require('../middleware/auth');

const router = express.Router();

const VALID_STATUSES = ['待发出', '使用中', '待回收核对', '待充电', '待复核', '恢复可用', '停用观察'];

function changeHeadphoneStatus(tx, headphoneId, fromStatus, toStatus, userId, remark) {
  tx.prepare(`
    UPDATE headphones
    SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(toStatus, headphoneId);

  tx.prepare(`
    INSERT INTO status_history (headphone_id, from_status, to_status, changed_by, remark)
    VALUES (?, ?, ?, ?, ?)
  `).run(headphoneId, fromStatus, toStatus, userId, remark || null);
}

router.get('/', authMiddleware, issuerMiddleware, (req, res) => {
  try {
    const {
      content_version, cabinet_position, responsible_person, status,
      start_date, end_date, min_battery, max_battery, page, page_size
    } = req.query;

    let sql = 'SELECT * FROM headphones WHERE 1=1';
    const params = [];

    if (content_version) {
      sql += ' AND content_version = ?';
      params.push(content_version);
    }
    if (cabinet_position) {
      sql += ' AND cabinet_position = ?';
      params.push(cabinet_position);
    }
    if (responsible_person) {
      sql += ' AND responsible_person = ?';
      params.push(responsible_person);
    }
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    if (min_battery !== undefined) {
      sql += ' AND battery_level >= ?';
      params.push(Number(min_battery));
    }
    if (max_battery !== undefined) {
      sql += ' AND battery_level <= ?';
      params.push(Number(max_battery));
    }
    if (start_date) {
      sql += ' AND DATE(created_at) >= ?';
      params.push(start_date);
    }
    if (end_date) {
      sql += ' AND DATE(created_at) <= ?';
      params.push(end_date);
    }

    sql += ' ORDER BY updated_at DESC';

    const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total');
    const total = db.prepare(countSql).get(...params).total;

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
    const hp = db.prepare('SELECT * FROM headphones WHERE id = ?').get(req.params.id);
    if (!hp) {
      return res.status(404).json({ error: '耳机不存在' });
    }
    const history = db.prepare(`
      SELECT sh.*, u.username, u.real_name
      FROM status_history sh
      LEFT JOIN users u ON sh.changed_by = u.id
      WHERE sh.headphone_id = ?
      ORDER BY sh.changed_at DESC
    `).all(req.params.id);
    const records = db.prepare(`
      SELECT br.*, bb.batch_no, ui.username as issuer_name, ur.username as returner_name, urv.username as reviewer_name
      FROM borrow_records br
      LEFT JOIN borrow_batches bb ON br.batch_id = bb.id
      LEFT JOIN users ui ON br.issued_by = ui.id
      LEFT JOIN users ur ON br.returned_by = ur.id
      LEFT JOIN users urv ON br.reviewed_by = urv.id
      WHERE br.headphone_id = ?
      ORDER BY br.issued_at DESC
    `).all(req.params.id);
    res.json({ ...hp, status_history: history, borrow_records: records });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const {
      serial_no, content_version, cabinet_position,
      responsible_person, maintenance_cycle_days, battery_level
    } = req.body;
    if (!serial_no) {
      return res.status(400).json({ error: '耳机编号不能为空' });
    }
    const existing = db.prepare('SELECT id FROM headphones WHERE serial_no = ?').get(serial_no);
    if (existing) {
      return res.status(409).json({ error: '耳机编号已存在' });
    }
    const result = db.prepare(`
      INSERT INTO headphones (serial_no, content_version, cabinet_position, responsible_person, maintenance_cycle_days, battery_level)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      serial_no,
      content_version || null,
      cabinet_position || null,
      responsible_person || null,
      maintenance_cycle_days || 30,
      battery_level !== undefined ? battery_level : null
    );
    const hp = db.prepare('SELECT * FROM headphones WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(hp);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const hp = db.prepare('SELECT * FROM headphones WHERE id = ?').get(req.params.id);
    if (!hp) {
      return res.status(404).json({ error: '耳机不存在' });
    }
    const {
      serial_no, content_version, cabinet_position,
      responsible_person, maintenance_cycle_days, battery_level,
      needs_review
    } = req.body;

    const fields = [];
    const params = [];
    if (serial_no !== undefined) {
      const dup = db.prepare('SELECT id FROM headphones WHERE serial_no = ? AND id != ?').get(serial_no, req.params.id);
      if (dup) {
        return res.status(409).json({ error: '耳机编号已存在' });
      }
      fields.push('serial_no = ?');
      params.push(serial_no);
    }
    if (content_version !== undefined) {
      fields.push('content_version = ?');
      params.push(content_version);
      if (content_version !== hp.content_version && hp.content_version) {
        fields.push('needs_review = ?');
        params.push(1);
      }
    }
    if (cabinet_position !== undefined) {
      fields.push('cabinet_position = ?');
      params.push(cabinet_position);
    }
    if (responsible_person !== undefined) {
      fields.push('responsible_person = ?');
      params.push(responsible_person);
    }
    if (maintenance_cycle_days !== undefined) {
      fields.push('maintenance_cycle_days = ?');
      params.push(maintenance_cycle_days);
    }
    if (battery_level !== undefined) {
      fields.push('battery_level = ?');
      params.push(battery_level);
    }
    if (needs_review !== undefined) {
      fields.push('needs_review = ?');
      params.push(needs_review ? 1 : 0);
    }
    if (fields.length === 0) {
      return res.status(400).json({ error: '未提供需要更新的字段' });
    }
    fields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(req.params.id);

    db.prepare(`UPDATE headphones SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    const updated = db.prepare('SELECT * FROM headphones WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id/status', authMiddleware, issuerMiddleware, (req, res) => {
  try {
    const { status, remark } = req.body;
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: '无效的状态值' });
    }
    const hp = db.prepare('SELECT * FROM headphones WHERE id = ?').get(req.params.id);
    if (!hp) {
      return res.status(404).json({ error: '耳机不存在' });
    }
    if (hp.status === status) {
      return res.json(hp);
    }

    const tx = db.transaction(() => {
      changeHeadphoneStatus(db, hp.id, hp.status, status, req.user.id, remark);
    });
    tx();

    const updated = db.prepare('SELECT * FROM headphones WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/maintenance', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const hp = db.prepare('SELECT * FROM headphones WHERE id = ?').get(req.params.id);
    if (!hp) {
      return res.status(404).json({ error: '耳机不存在' });
    }
    const { maintenance_date, notes } = req.body;
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO maintenance_logs (headphone_id, maintained_by, maintenance_date, notes)
        VALUES (?, ?, ?, ?)
      `).run(req.params.id, req.user.id, maintenance_date || new Date().toISOString().slice(0, 10), notes || null);

      db.prepare(`
        UPDATE headphones
        SET last_maintenance_date = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(maintenance_date || new Date().toISOString().slice(0, 10), req.params.id);
    });
    tx();

    const log = db.prepare(`
      SELECT ml.*, u.username, u.real_name
      FROM maintenance_logs ml
      LEFT JOIN users u ON ml.maintained_by = u.id
      WHERE ml.headphone_id = ?
      ORDER BY ml.maintenance_date DESC
      LIMIT 1
    `).get(req.params.id);
    res.status(201).json(log);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const hp = db.prepare('SELECT * FROM headphones WHERE id = ?').get(req.params.id);
    if (!hp) {
      return res.status(404).json({ error: '耳机不存在' });
    }
    const inActiveBatch = db.prepare(`
      SELECT br.id FROM borrow_records br
      JOIN borrow_batches bb ON br.batch_id = bb.id
      WHERE br.headphone_id = ? AND bb.is_active = 1 AND br.returned_at IS NULL
    `).get(req.params.id);
    if (inActiveBatch) {
      return res.status(400).json({ error: '该耳机当前在活跃批次中，无法删除' });
    }
    db.prepare('DELETE FROM headphones WHERE id = ?').run(req.params.id);
    res.json({ message: '删除成功' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, changeHeadphoneStatus, VALID_STATUSES };
