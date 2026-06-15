const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authMiddleware, adminMiddleware, generateToken } = require('../middleware/auth');

const router = express.Router();

router.post('/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    const isValid = bcrypt.compareSync(password, user.password);
    if (!isValid) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    const token = generateToken(user);
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        real_name: user.real_name
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/register', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { username, password, role, real_name } = req.body;
    if (!username || !password || !role) {
      return res.status(400).json({ error: '用户名、密码和角色不能为空' });
    }
    if (!['admin', 'issuer'].includes(role)) {
      return res.status(400).json({ error: '角色必须是 admin 或 issuer' });
    }
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      return res.status(409).json({ error: '用户名已存在' });
    }
    const salt = bcrypt.genSaltSync(10);
    const hashed = bcrypt.hashSync(password, salt);
    const result = db.prepare(`
      INSERT INTO users (username, password, role, real_name)
      VALUES (?, ?, ?, ?)
    `).run(username, hashed, role, real_name || username);
    const user = db.prepare('SELECT id, username, role, real_name, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, username, role, real_name, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }
  res.json(user);
});

router.get('/users', authMiddleware, adminMiddleware, (req, res) => {
  const users = db.prepare('SELECT id, username, role, real_name, created_at FROM users ORDER BY created_at DESC').all();
  res.json(users);
});

router.put('/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { password, role, real_name } = req.body;
    const fields = [];
    const params = [];
    if (password) {
      const salt = bcrypt.genSaltSync(10);
      fields.push('password = ?');
      params.push(bcrypt.hashSync(password, salt));
    }
    if (role) {
      if (!['admin', 'issuer'].includes(role)) {
        return res.status(400).json({ error: '角色必须是 admin 或 issuer' });
      }
      fields.push('role = ?');
      params.push(role);
    }
    if (real_name !== undefined) {
      fields.push('real_name = ?');
      params.push(real_name);
    }
    if (fields.length === 0) {
      return res.status(400).json({ error: '未提供需要更新的字段' });
    }
    params.push(req.params.id);
    const result = db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    if (result.changes === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }
    const user = db.prepare('SELECT id, username, role, real_name, created_at FROM users WHERE id = ?').get(req.params.id);
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  try {
    if (Number(req.params.id) === req.user.id) {
      return res.status(400).json({ error: '不能删除当前登录用户' });
    }
    const result = db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }
    res.json({ message: '删除成功' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
