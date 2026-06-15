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
  const overdueBatches = db.prepare(`
    SELECT bb.id as batch_id, bb.batch_no, bb.expected_return_date, bb.purpose,
      u.real_name as issuer_name,
      COUNT(br.id) as unreturned_count,
      MIN(br.issued_at) as first_issued_at,
      MAX(br.issued_at) as last_issued_at,
      (JULIANDAY(CURRENT_TIMESTAMP) - JULIANDAY(MIN(br.issued_at))) as max_days_issued,
      (SELECT COUNT(*) FROM collection_followups cf WHERE cf.batch_id = bb.id) as followup_count,
      (SELECT cf.collected_at FROM collection_followups cf WHERE cf.batch_id = bb.id ORDER BY cf.collected_at DESC LIMIT 1) as last_followup_at,
      (SELECT uu.real_name FROM collection_followups cf LEFT JOIN users uu ON cf.collected_by = uu.id WHERE cf.batch_id = bb.id ORDER BY cf.collected_at DESC LIMIT 1) as last_followup_by,
      (SELECT cf.communication_method FROM collection_followups cf WHERE cf.batch_id = bb.id ORDER BY cf.collected_at DESC LIMIT 1) as last_followup_method,
      (SELECT cf.remark FROM collection_followups cf WHERE cf.batch_id = bb.id ORDER BY cf.collected_at DESC LIMIT 1) as last_followup_remark,
      (SELECT cf.expected_return_date FROM collection_followups cf WHERE cf.batch_id = bb.id ORDER BY cf.collected_at DESC LIMIT 1) as last_expected_return
    FROM borrow_batches bb
    JOIN borrow_records br ON bb.id = br.batch_id
    LEFT JOIN users u ON bb.issuer_id = u.id
    WHERE br.returned_at IS NULL
      AND bb.is_active = 1
      AND (
        (bb.expected_return_date IS NOT NULL AND DATE(bb.expected_return_date) < DATE(CURRENT_TIMESTAMP, '+2 days'))
        OR (JULIANDAY(CURRENT_TIMESTAMP) - JULIANDAY(br.issued_at)) > 1
      )
    GROUP BY bb.id
    ORDER BY max_days_issued DESC
  `).all();

  return overdueBatches.map(o => {
    const headphones = db.prepare(`
      SELECT h.id, h.serial_no, h.responsible_person, h.status, br.issued_at,
        (JULIANDAY(CURRENT_TIMESTAMP) - JULIANDAY(br.issued_at)) as days_issued
      FROM borrow_records br
      JOIN headphones h ON br.headphone_id = h.id
      WHERE br.batch_id = ? AND br.returned_at IS NULL
      ORDER BY br.issued_at DESC
    `).all(o.batch_id);

    const isOverdue = o.expected_return_date
      ? new Date(o.expected_return_date) < new Date(new Date().toDateString())
      : o.max_days_issued > 3;

    return {
      type: 'UNRETURNED_OVERDUE',
      severity: o.max_days_issued > 7 ? 'high' : (isOverdue ? 'high' : 'medium'),
      batch_id: o.batch_id,
      batch_no: o.batch_no,
      issuer_name: o.issuer_name,
      purpose: o.purpose,
      unreturned_count: o.unreturned_count,
      first_issued_at: o.first_issued_at,
      last_issued_at: o.last_issued_at,
      max_days_issued: parseFloat(o.max_days_issued.toFixed(1)),
      expected_return_date: o.expected_return_date,
      is_overdue: isOverdue ? 1 : 0,
      message: `批次 ${o.batch_no} 有 ${o.unreturned_count} 副耳机未归还${isOverdue ? '（已逾期）' : '（临近归还）'}`,
      details: `最早发出 ${o.max_days_issued.toFixed(1)} 天前，期望归还日 ${o.expected_return_date || '无'}，发放人 ${o.issuer_name || '未知'}`,
      headphones: headphones.map(h => ({
        ...h,
        days_issued: parseFloat(h.days_issued.toFixed(1))
      })),
      followup_count: o.followup_count,
      last_followup_at: o.last_followup_at,
      last_followup_by: o.last_followup_by,
      last_followup_method: o.last_followup_method,
      last_followup_remark: o.last_followup_remark,
      last_expected_return: o.last_expected_return
    };
  });
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

    let countSql = 'SELECT COUNT(*) as total FROM alerts a WHERE 1=1';
    const countParams = [];
    if (alert_type) {
      countSql += ' AND a.alert_type = ?';
      countParams.push(alert_type);
    }
    if (severity) {
      countSql += ' AND a.severity = ?';
      countParams.push(severity);
    }
    if (is_resolved !== undefined) {
      countSql += ' AND a.is_resolved = ?';
      countParams.push(is_resolved === 'true' || is_resolved === '1' ? 1 : 0);
    }
    const total = db.prepare(countSql).get(...countParams).total;

    const pg = Math.max(1, Number(page) || 1);
    const ps = Math.min(100, Math.max(1, Number(page_size) || 50));
    sql += ' LIMIT ? OFFSET ?';
    params.push(ps, (pg - 1) * ps);

    const items = db.prepare(sql).all(...params);
    const enrichedItems = items.map(a => {
      if (a.batch_id) {
        const followupStats = db.prepare(`
          SELECT
            COUNT(*) as followup_count,
            (SELECT cf.collected_at FROM collection_followups cf WHERE cf.batch_id = ? ORDER BY cf.collected_at DESC LIMIT 1) as last_followup_at,
            (SELECT uu.real_name FROM collection_followups cf LEFT JOIN users uu ON cf.collected_by = uu.id WHERE cf.batch_id = ? ORDER BY cf.collected_at DESC LIMIT 1) as last_followup_by,
            (SELECT cf.communication_method FROM collection_followups cf WHERE cf.batch_id = ? ORDER BY cf.collected_at DESC LIMIT 1) as last_followup_method,
            (SELECT cf.remark FROM collection_followups cf WHERE cf.batch_id = ? ORDER BY cf.collected_at DESC LIMIT 1) as last_followup_remark,
            (SELECT cf.expected_return_date FROM collection_followups cf WHERE cf.batch_id = ? ORDER BY cf.collected_at DESC LIMIT 1) as last_expected_return
          FROM collection_followups cf WHERE cf.batch_id = ?
        `).get(a.batch_id, a.batch_id, a.batch_id, a.batch_id, a.batch_id, a.batch_id);
        return { ...a, ...followupStats };
      }
      return a;
    });
    res.json({
      items: enrichedItems,
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
