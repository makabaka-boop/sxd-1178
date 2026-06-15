const express = require('express');
const db = require('../db');
const { authMiddleware, adminMiddleware, issuerMiddleware } = require('../middleware/auth');

const router = express.Router();

router.get('/', authMiddleware, issuerMiddleware, (req, res) => {
  try {
    const cases = db.prepare(`
      SELECT cc.*,
        (SELECT COUNT(*) FROM case_headphones ch WHERE ch.case_id = cc.id AND ch.removed_at IS NULL) as actual_count
      FROM charging_cases cc
      ORDER BY cc.case_no
    `).all();
    res.json(cases);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', authMiddleware, issuerMiddleware, (req, res) => {
  try {
    const cc = db.prepare(`
      SELECT cc.*,
        (SELECT COUNT(*) FROM case_headphones ch WHERE ch.case_id = cc.id AND ch.removed_at IS NULL) as actual_count
      FROM charging_cases cc
      WHERE cc.id = ?
    `).get(req.params.id);
    if (!cc) {
      return res.status(404).json({ error: '充电盒不存在' });
    }
    const headphones = db.prepare(`
      SELECT h.*, ch.placed_at
      FROM case_headphones ch
      JOIN headphones h ON ch.headphone_id = h.id
      WHERE ch.case_id = ? AND ch.removed_at IS NULL
      ORDER BY ch.placed_at
    `).all(req.params.id);
    res.json({ ...cc, headphones });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { case_no, capacity, location } = req.body;
    if (!case_no || capacity === undefined) {
      return res.status(400).json({ error: '充电盒编号和容量不能为空' });
    }
    if (capacity <= 0) {
      return res.status(400).json({ error: '容量必须大于0' });
    }
    const existing = db.prepare('SELECT id FROM charging_cases WHERE case_no = ?').get(case_no);
    if (existing) {
      return res.status(409).json({ error: '充电盒编号已存在' });
    }
    const result = db.prepare(`
      INSERT INTO charging_cases (case_no, capacity, location)
      VALUES (?, ?, ?)
    `).run(case_no, capacity, location || null);
    const cc = db.prepare('SELECT * FROM charging_cases WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(cc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const cc = db.prepare('SELECT * FROM charging_cases WHERE id = ?').get(req.params.id);
    if (!cc) {
      return res.status(404).json({ error: '充电盒不存在' });
    }
    const { case_no, capacity, location } = req.body;
    const fields = [];
    const params = [];

    if (case_no !== undefined) {
      const dup = db.prepare('SELECT id FROM charging_cases WHERE case_no = ? AND id != ?').get(case_no, req.params.id);
      if (dup) {
        return res.status(409).json({ error: '充电盒编号已存在' });
      }
      fields.push('case_no = ?');
      params.push(case_no);
    }
    if (capacity !== undefined) {
      if (capacity <= 0) {
        return res.status(400).json({ error: '容量必须大于0' });
      }
      const currentCount = db.prepare(
        'SELECT COUNT(*) as cnt FROM case_headphones WHERE case_id = ? AND removed_at IS NULL'
      ).get(req.params.id).cnt;
      if (capacity < currentCount) {
        return res.status(400).json({ error: `容量不能小于当前存放数量 ${currentCount}` });
      }
      fields.push('capacity = ?');
      params.push(capacity);
    }
    if (location !== undefined) {
      fields.push('location = ?');
      params.push(location);
    }
    if (fields.length === 0) {
      return res.status(400).json({ error: '未提供需要更新的字段' });
    }
    params.push(req.params.id);
    db.prepare(`UPDATE charging_cases SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    const updated = db.prepare('SELECT * FROM charging_cases WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/headphones', authMiddleware, issuerMiddleware, (req, res) => {
  try {
    const { headphone_id } = req.body;
    if (!headphone_id) {
      return res.status(400).json({ error: '耳机ID不能为空' });
    }
    const cc = db.prepare('SELECT * FROM charging_cases WHERE id = ?').get(req.params.id);
    if (!cc) {
      return res.status(404).json({ error: '充电盒不存在' });
    }
    const hp = db.prepare('SELECT * FROM headphones WHERE id = ?').get(headphone_id);
    if (!hp) {
      return res.status(404).json({ error: '耳机不存在' });
    }
    const alreadyIn = db.prepare(
      'SELECT id FROM case_headphones WHERE headphone_id = ? AND removed_at IS NULL'
    ).get(headphone_id);
    if (alreadyIn) {
      return res.status(400).json({ error: '该耳机已在某个充电盒中' });
    }
    const currentCount = db.prepare(
      'SELECT COUNT(*) as cnt FROM case_headphones WHERE case_id = ? AND removed_at IS NULL'
    ).get(req.params.id).cnt;
    if (currentCount >= cc.capacity) {
      return res.status(400).json({ error: `充电盒容量已满 (${cc.capacity}/${cc.capacity})` });
    }
    db.prepare(`
      INSERT INTO case_headphones (case_id, headphone_id)
      VALUES (?, ?)
    `).run(req.params.id, headphone_id);

    db.prepare(`
      UPDATE headphones SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run('待充电', headphone_id);

    res.status(201).json({ message: '耳机已放入充电盒' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id/headphones/:headphone_id', authMiddleware, issuerMiddleware, (req, res) => {
  try {
    const cc = db.prepare('SELECT * FROM charging_cases WHERE id = ?').get(req.params.id);
    if (!cc) {
      return res.status(404).json({ error: '充电盒不存在' });
    }
    const rel = db.prepare(
      'SELECT * FROM case_headphones WHERE case_id = ? AND headphone_id = ? AND removed_at IS NULL'
    ).get(req.params.id, req.params.headphone_id);
    if (!rel) {
      return res.status(404).json({ error: '该耳机不在此充电盒中' });
    }
    db.prepare(`
      UPDATE case_headphones SET removed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(rel.id);

    db.prepare(`
      UPDATE headphones SET battery_level = 100, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(req.params.headphone_id);

    res.json({ message: '耳机已取出，电量已充满' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const cc = db.prepare('SELECT * FROM charging_cases WHERE id = ?').get(req.params.id);
    if (!cc) {
      return res.status(404).json({ error: '充电盒不存在' });
    }
    const currentCount = db.prepare(
      'SELECT COUNT(*) as cnt FROM case_headphones WHERE case_id = ? AND removed_at IS NULL'
    ).get(req.params.id).cnt;
    if (currentCount > 0) {
      return res.status(400).json({ error: '充电盒中仍有耳机，无法删除' });
    }
    db.prepare('DELETE FROM charging_cases WHERE id = ?').run(req.params.id);
    res.json({ message: '删除成功' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
