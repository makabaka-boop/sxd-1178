const express = require('express');
const db = require('../db');
const { authMiddleware, issuerMiddleware, adminMiddleware } = require('../middleware/auth');

const router = express.Router();

function detectVersionMixing() {
  const batches = db.prepare(`
    SELECT bb.id, bb.batch_no, bb.created_at, bb.is_active
    FROM borrow_batches bb
    WHERE bb.is_active = 1
  `).all();

  const issues = [];
  for (const bb of batches) {
    const versions = db.prepare(`
      SELECT DISTINCT h.content_version
      FROM borrow_records br
      JOIN headphones h ON br.headphone_id = h.id
      WHERE br.batch_id = ? AND br.returned_at IS NULL
        AND h.content_version IS NOT NULL
    `).all(bb.id);
    if (versions.length > 1) {
      const versionList = versions.map(v => v.content_version).join(', ');
      const count = db.prepare(`
        SELECT COUNT(*) as cnt FROM borrow_records
        WHERE batch_id = ? AND returned_at IS NULL
      `).get(bb.id).cnt;
      issues.push({
        type: 'VERSION_MIXING',
        severity: 'high',
        batch_id: bb.id,
        batch_no: bb.batch_no,
        message: `批次 ${bb.batch_no} 存在内容版本混用`,
        details: `涉及 ${count} 副耳机，版本有：${versionList}`,
        versions: versions.map(v => v.content_version)
      });
    }
  }
  return issues;
}

function detectLowBatteryBacklog() {
  const backlogs = db.prepare(`
    SELECT h.cabinet_position,
      COUNT(*) as total_count,
      SUM(CASE WHEN h.battery_level < 50 THEN 1 ELSE 0 END) as low_battery_count,
      MAX(h.updated_at) as last_update
    FROM headphones h
    WHERE h.status IN ('待发出', '恢复可用', '待回收核对', '待充电')
      AND h.cabinet_position IS NOT NULL
    GROUP BY h.cabinet_position
    HAVING low_battery_count >= 2
    ORDER BY low_battery_count DESC
  `).all();

  const issues = [];
  for (const b of backlogs) {
    const now = new Date();
    const lastUpd = new Date(b.last_update);
    const daysDiff = Math.floor((now - lastUpd) / (1000 * 60 * 60 * 24));
    if (daysDiff >= 2) {
      issues.push({
        type: 'LOW_BATTERY_BACKLOG',
        severity: 'medium',
        cabinet_position: b.cabinet_position,
        message: `柜位 ${b.cabinet_position} 长期积压低电量耳机`,
        details: `共 ${b.total_count} 副，其中 ${b.low_battery_count} 副电量<50%，上次更新 ${daysDiff} 天前`,
        total_count: b.total_count,
        low_battery_count: b.low_battery_count,
        stale_days: daysDiff
      });
    }
  }
  return issues;
}

function detectUnreturnedOverdue() {
  const overdue = db.prepare(`
    SELECT br.id as record_id, br.issued_at, bb.batch_no, bb.expected_return_date,
      h.serial_no, h.responsible_person,
      (JULIANDAY(CURRENT_TIMESTAMP) - JULIANDAY(br.issued_at)) as days_issued
    FROM borrow_records br
    JOIN borrow_batches bb ON br.batch_id = bb.id
    JOIN headphones h ON br.headphone_id = h.id
    WHERE br.returned_at IS NULL
      AND bb.is_active = 1
      AND (
        (bb.expected_return_date IS NOT NULL AND DATE(bb.expected_return_date) < DATE(CURRENT_TIMESTAMP))
        OR (JULIANDAY(CURRENT_TIMESTAMP) - JULIANDAY(br.issued_at)) > 3
      )
    ORDER BY days_issued DESC
  `).all();

  return overdue.map(o => ({
    type: 'UNRETURNED_OVERDUE',
    severity: o.days_issued > 7 ? 'high' : 'medium',
    record_id: o.record_id,
    batch_no: o.batch_no,
    serial_no: o.serial_no,
    responsible_person: o.responsible_person,
    message: `耳机 ${o.serial_no} 发出后迟迟未回收`,
    details: `批次 ${o.batch_no}，发出 ${o.days_issued.toFixed(1)} 天，期望归还日 ${o.expected_return_date || '无'}`,
    days_issued: parseFloat(o.days_issued.toFixed(1)),
    expected_return_date: o.expected_return_date
  }));
}

function detectConsecutiveAuditionAbnormal() {
  const owners = db.prepare(`
    SELECT DISTINCT h.responsible_person
    FROM headphones h
    WHERE h.responsible_person IS NOT NULL
  `).all();

  const issues = [];
  for (const o of owners) {
    const recentRecords = db.prepare(`
      SELECT br.id, br.audition_result, br.issued_at, h.serial_no
      FROM borrow_records br
      JOIN headphones h ON br.headphone_id = h.id
      WHERE h.responsible_person = ?
        AND br.audition_result IS NOT NULL
      ORDER BY br.issued_at DESC
      LIMIT 3
    `).all(o.responsible_person);
    if (recentRecords.length >= 3) {
      const allAbnormal = recentRecords.every(r => r.audition_result === '异常');
      if (allAbnormal) {
        issues.push({
          type: 'CONSECUTIVE_ABNORMAL',
          severity: 'high',
          responsible_person: o.responsible_person,
          message: `责任人 ${o.responsible_person} 名下连续 3 次试听异常`,
          details: `涉及耳机：${recentRecords.map(r => r.serial_no).join('、')}`,
          affected_records: recentRecords
        });
      }
    }
  }
  return issues;
}

function runAllChecks() {
  return [
    ...detectVersionMixing(),
    ...detectLowBatteryBacklog(),
    ...detectUnreturnedOverdue(),
    ...detectConsecutiveAuditionAbnormal()
  ];
}

router.get('/detect', authMiddleware, issuerMiddleware, (req, res) => {
  try {
    const results = runAllChecks();
    res.json({
      total: results.length,
      items: results
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/version-mixing', authMiddleware, issuerMiddleware, (req, res) => {
  try {
    const issues = detectVersionMixing();
    res.json({ total: issues.length, items: issues });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/low-battery-backlog', authMiddleware, issuerMiddleware, (req, res) => {
  try {
    const issues = detectLowBatteryBacklog();
    res.json({ total: issues.length, items: issues });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/unreturned-overdue', authMiddleware, issuerMiddleware, (req, res) => {
  try {
    const issues = detectUnreturnedOverdue();
    res.json({ total: issues.length, items: issues });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/consecutive-abnormal', authMiddleware, issuerMiddleware, (req, res) => {
  try {
    const issues = detectConsecutiveAuditionAbnormal();
    res.json({ total: issues.length, items: issues });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/', authMiddleware, issuerMiddleware, (req, res) => {
  try {
    const { alert_type, severity, is_resolved, page, page_size } = req.query;
    let sql = `
      SELECT a.*, h.serial_no, bb.batch_no, u.username
      FROM alerts a
      LEFT JOIN headphones h ON a.headphone_id = h.id
      LEFT JOIN borrow_batches bb ON a.batch_id = bb.id
      LEFT JOIN users u ON a.user_id = u.id
      WHERE 1=1
    `;
    const params = [];
    if (alert_type) {
      sql += ' AND a.alert_type = ?';
      params.push(alert_type);
    }
    if (severity) {
      sql += ' AND a.severity = ?';
      params.push(severity);
    }
    if (is_resolved !== undefined) {
      sql += ' AND a.is_resolved = ?';
      params.push(is_resolved === 'true' || is_resolved === '1' ? 1 : 0);
    }
    sql += ' ORDER BY a.created_at DESC';

    const countSql = sql.replace(
      /SELECT a\.\*, h\.serial_no.*?FROM alerts/,
      'SELECT COUNT(*) as total FROM alerts a'
    ).replace(/LEFT JOIN headphones h ON a\.headphone_id = h\.id/, '')
      .replace(/LEFT JOIN borrow_batches bb ON a\.batch_id = bb\.id/, '')
      .replace(/LEFT JOIN users u ON a\.user_id = u\.id/, '');
    const total = db.prepare(countSql).get(...params).total;

    const pg = Math.max(1, Number(page) || 1);
    const ps = Math.min(100, Math.max(1, Number(page_size) || 50));
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

router.put('/:id/resolve', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const a = db.prepare('SELECT * FROM alerts WHERE id = ?').get(req.params.id);
    if (!a) {
      return res.status(404).json({ error: '告警不存在' });
    }
    db.prepare(`
      UPDATE alerts SET is_resolved = 1, resolved_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(req.params.id);
    const updated = db.prepare('SELECT * FROM alerts WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, runAllChecks };
