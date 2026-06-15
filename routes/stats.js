const express = require('express');
const db = require('../db');
const { authMiddleware, issuerMiddleware } = require('../middleware/auth');

const router = express.Router();

router.get('/low-battery-list', authMiddleware, issuerMiddleware, (req, res) => {
  try {
    const { threshold = 30, cabinet_position, responsible_person } = req.query;
    let sql = `
      SELECT h.*,
        (JULIANDAY(CURRENT_TIMESTAMP) - JULIANDAY(h.updated_at)) as days_since_update
      FROM headphones h
      WHERE h.battery_level <= ?
    `;
    const params = [Number(threshold)];
    if (cabinet_position) {
      sql += ' AND h.cabinet_position = ?';
      params.push(cabinet_position);
    }
    if (responsible_person) {
      sql += ' AND h.responsible_person = ?';
      params.push(responsible_person);
    }
    sql += ' ORDER BY h.battery_level ASC';
    const items = db.prepare(sql).all(...params);
    res.json({
      threshold: Number(threshold),
      total: items.length,
      items
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/version-stats', authMiddleware, issuerMiddleware, (req, res) => {
  try {
    const versionCounts = db.prepare(`
      SELECT content_version,
        COUNT(*) as total_count,
        SUM(CASE WHEN status = '待发出' THEN 1 ELSE 0 END) as ready_count,
        SUM(CASE WHEN status = '使用中' THEN 1 ELSE 0 END) as in_use_count,
        SUM(CASE WHEN status = '待充电' THEN 1 ELSE 0 END) as charging_count,
        SUM(CASE WHEN status = '待复核' THEN 1 ELSE 0 END) as review_count,
        SUM(CASE WHEN status = '恢复可用' THEN 1 ELSE 0 END) as recovered_count,
        SUM(CASE WHEN needs_review = 1 THEN 1 ELSE 0 END) as needs_review_count
      FROM headphones
      WHERE content_version IS NOT NULL
      GROUP BY content_version
      ORDER BY content_version
    `).all();

    const activeBatches = db.prepare(`
      SELECT bb.id, bb.batch_no,
        COUNT(DISTINCT h.content_version) as version_count,
        GROUP_CONCAT(DISTINCT h.content_version) as versions
      FROM borrow_batches bb
      JOIN borrow_records br ON bb.id = br.batch_id
      JOIN headphones h ON br.headphone_id = h.id
      WHERE bb.is_active = 1 AND br.returned_at IS NULL
      GROUP BY bb.id
      HAVING version_count > 1
    `).all();

    const mismatches = db.prepare(`
      SELECT id, headphone_id, content_version_issued, content_version_return,
        issued_at, returned_at
      FROM borrow_records
      WHERE content_version_issued IS NOT NULL
        AND content_version_return IS NOT NULL
        AND content_version_issued != content_version_return
      ORDER BY returned_at DESC
      LIMIT 50
    `).all();

    res.json({
      version_distribution: versionCounts,
      active_mixed_batches: activeBatches,
      return_mismatches: mismatches,
      mixed_batch_count: activeBatches.length,
      mismatch_count: mismatches.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/turnover-distribution', authMiddleware, issuerMiddleware, (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    let sql = `
      SELECT br.headphone_id, h.serial_no,
        br.issued_at,
        COALESCE(br.returned_at, CURRENT_TIMESTAMP) as end_time,
        (JULIANDAY(COALESCE(br.returned_at, CURRENT_TIMESTAMP)) - JULIANDAY(br.issued_at)) * 24 as duration_hours
      FROM borrow_records br
      JOIN headphones h ON br.headphone_id = h.id
      WHERE br.returned_at IS NOT NULL
    `;
    const params = [];
    if (start_date) {
      sql += ' AND DATE(br.issued_at) >= ?';
      params.push(start_date);
    }
    if (end_date) {
      sql += ' AND DATE(br.returned_at) <= ?';
      params.push(end_date);
    }
    const records = db.prepare(sql).all(...params);

    const buckets = [
      { label: '< 1小时', min: 0, max: 1, count: 0, records: [] },
      { label: '1-4小时', min: 1, max: 4, count: 0, records: [] },
      { label: '4-8小时', min: 4, max: 8, count: 0, records: [] },
      { label: '8-24小时', min: 8, max: 24, count: 0, records: [] },
      { label: '1-3天', min: 24, max: 72, count: 0, records: [] },
      { label: '3-7天', min: 72, max: 168, count: 0, records: [] },
      { label: '> 7天', min: 168, max: Infinity, count: 0, records: [] }
    ];

    let totalDuration = 0;
    const headphoneStats = {};
    for (const r of records) {
      const d = r.duration_hours;
      totalDuration += d;
      for (const b of buckets) {
        if (d >= b.min && d < b.max) {
          b.count++;
          b.records.push({ serial_no: r.serial_no, duration_hours: parseFloat(d.toFixed(2)) });
          break;
        }
      }
      if (!headphoneStats[r.headphone_id]) {
        headphoneStats[r.headphone_id] = { serial_no: r.serial_no, count: 0, total_hours: 0 };
      }
      headphoneStats[r.headphone_id].count++;
      headphoneStats[r.headphone_id].total_hours += d;
    }

    const perHeadphone = Object.values(headphoneStats)
      .map(s => ({
        ...s,
        avg_hours: parseFloat((s.total_hours / s.count).toFixed(2)),
        total_hours: parseFloat(s.total_hours.toFixed(2))
      }))
      .sort((a, b) => b.count - a.count);

    res.json({
      range: { start_date: start_date || null, end_date: end_date || null },
      total_records: records.length,
      avg_duration_hours: records.length > 0 ? parseFloat((totalDuration / records.length).toFixed(2)) : 0,
      distribution: buckets.map(b => ({
        label: b.label,
        count: b.count,
        percentage: records.length > 0 ? parseFloat(((b.count / records.length) * 100).toFixed(2)) : 0
      })),
      per_headphone: perHeadphone
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/dashboard', authMiddleware, issuerMiddleware, (req, res) => {
  try {
    const statusSummary = db.prepare(`
      SELECT status, COUNT(*) as count
      FROM headphones
      GROUP BY status
      ORDER BY count DESC
    `).all();

    const activeBatchCount = db.prepare(
      "SELECT COUNT(*) as cnt FROM borrow_batches WHERE is_active = 1"
    ).get().cnt;

    const unreturnedCount = db.prepare(`
      SELECT COUNT(*) as cnt
      FROM borrow_records br
      JOIN borrow_batches bb ON br.batch_id = bb.id
      WHERE br.returned_at IS NULL AND bb.is_active = 1
    `).get().cnt;

    const lowBatteryCount = db.prepare(
      'SELECT COUNT(*) as cnt FROM headphones WHERE battery_level < 30'
    ).get().cnt;

    const pendingReviewCount = db.prepare(
      "SELECT COUNT(*) as cnt FROM headphones WHERE status = '待复核'"
    ).get().cnt;

    const needsReviewCount = db.prepare(
      'SELECT COUNT(*) as cnt FROM headphones WHERE needs_review = 1'
    ).get().cnt;

    const unresolvedAlerts = db.prepare(
      'SELECT COUNT(*) as cnt FROM alerts WHERE is_resolved = 0'
    ).get().cnt;

    const todayStats = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM borrow_records WHERE DATE(issued_at) = DATE(CURRENT_TIMESTAMP)) as today_issued,
        (SELECT COUNT(*) FROM borrow_records WHERE DATE(returned_at) = DATE(CURRENT_TIMESTAMP)) as today_returned,
        (SELECT COUNT(*) FROM status_history WHERE DATE(changed_at) = DATE(CURRENT_TIMESTAMP)) as today_status_changes,
        (SELECT COUNT(*) FROM collection_followups WHERE DATE(collected_at) = DATE(CURRENT_TIMESTAMP)) as today_followups
    `).get();

    const overdueUnreturnedBatches = db.prepare(`
      SELECT COUNT(DISTINCT bb.id) as cnt
      FROM borrow_batches bb
      JOIN borrow_records br ON bb.id = br.batch_id
      WHERE bb.is_active = 1 AND br.returned_at IS NULL
        AND (
          (bb.expected_return_date IS NOT NULL AND DATE(bb.expected_return_date) < DATE(CURRENT_TIMESTAMP))
          OR (JULIANDAY(CURRENT_TIMESTAMP) - JULIANDAY(br.issued_at)) > 3
        )
    `).get().cnt;

    const followedUnreturnedBatches = db.prepare(`
      SELECT COUNT(DISTINCT bb.id) as cnt
      FROM borrow_batches bb
      JOIN borrow_records br ON bb.id = br.batch_id
      WHERE bb.is_active = 1 AND br.returned_at IS NULL
        AND EXISTS (SELECT 1 FROM collection_followups cf WHERE cf.batch_id = bb.id)
    `).get().cnt;

    const ownerSummary = db.prepare(`
      SELECT responsible_person,
        COUNT(*) as total,
        SUM(CASE WHEN status = '使用中' THEN 1 ELSE 0 END) as in_use,
        SUM(CASE WHEN battery_level < 50 THEN 1 ELSE 0 END) as low_battery
      FROM headphones
      WHERE responsible_person IS NOT NULL
      GROUP BY responsible_person
      ORDER BY total DESC
    `).all();

    const cabinetSummary = db.prepare(`
      SELECT cabinet_position,
        COUNT(*) as total,
        AVG(battery_level) as avg_battery
      FROM headphones
      WHERE cabinet_position IS NOT NULL
      GROUP BY cabinet_position
      ORDER BY total DESC
    `).all();

    const pendingReviewHeadphones = db.prepare(
      "SELECT COUNT(*) as cnt FROM headphones WHERE status = '待复核'"
    ).get().cnt;

    const pendingDisposalCount = db.prepare(
      "SELECT COUNT(*) as cnt FROM disposal_records WHERE disposal_status = '待处置'"
    ).get().cnt;

    const disposingCount = db.prepare(
      "SELECT COUNT(*) as cnt FROM disposal_records WHERE disposal_status = '处置中'"
    ).get().cnt;

    const todayDisposedCount = db.prepare(
      "SELECT COUNT(*) as cnt FROM disposal_records WHERE DATE(handled_at) = DATE(CURRENT_TIMESTAMP)"
    ).get().cnt;

    const todayDisposalCreatedCount = db.prepare(
      "SELECT COUNT(*) as cnt FROM disposal_records WHERE DATE(created_at) = DATE(CURRENT_TIMESTAMP)"
    ).get().cnt;

    const abnormalDisposalSummary = db.prepare(`
      SELECT disposal_type, COUNT(*) as count
      FROM disposal_records
      GROUP BY disposal_type
      ORDER BY count DESC
    `).all();

    const disposalConclusionSummary = db.prepare(`
      SELECT disposal_conclusion, COUNT(*) as count
      FROM disposal_records
      WHERE disposal_conclusion IS NOT NULL
      GROUP BY disposal_conclusion
      ORDER BY count DESC
    `).all();

    const chargingHeadphoneCount = db.prepare(
      "SELECT COUNT(*) as cnt FROM headphones WHERE status = '待充电'"
    ).get().cnt;

    const allStatusCounts = {};
    for (const row of statusSummary) {
      allStatusCounts[row.status] = row.count;
    }

    const batchCompletionStats = db.prepare(`
      SELECT
        bb.id, bb.batch_no,
        (SELECT COUNT(*) FROM borrow_records br WHERE br.batch_id = bb.id) as total_count,
        (SELECT COUNT(*) FROM borrow_records br WHERE br.batch_id = bb.id AND br.returned_at IS NOT NULL) as returned_count,
        (SELECT COUNT(*) FROM disposal_records dr WHERE dr.batch_id = bb.id AND dr.disposal_status = '待处置') as pending_disposal_count,
        (SELECT COUNT(*) FROM disposal_records dr WHERE dr.batch_id = bb.id AND dr.disposal_status = '处置中') as disposing_count,
        (SELECT COUNT(*) FROM disposal_records dr WHERE dr.batch_id = bb.id AND dr.disposal_status = '已处置') as disposed_count,
        (SELECT COUNT(DISTINCT dr.headphone_id) FROM disposal_records dr WHERE dr.batch_id = bb.id AND dr.disposal_status IN ('待处置','处置中')) as pending_review_count
      FROM borrow_batches bb
      WHERE bb.is_active = 1
      ORDER BY bb.created_at DESC
    `).all().map(b => ({
      ...b,
      completion_rate: b.total_count > 0
        ? parseFloat(((b.returned_count / b.total_count) * 100).toFixed(1))
        : 0
    }));

    const overallReturnRate = (() => {
      const totalRecords = db.prepare('SELECT COUNT(*) as cnt FROM borrow_records WHERE returned_at IS NOT NULL').get().cnt;
      const totalAll = db.prepare('SELECT COUNT(*) as cnt FROM borrow_records').get().cnt;
      return totalAll > 0 ? parseFloat(((totalRecords / totalAll) * 100).toFixed(1)) : 0;
    })();

    res.json({
      status_summary: statusSummary,
      status_counts: allStatusCounts,
      active_batch_count: activeBatchCount,
      unreturned_count: unreturnedCount,
      low_battery_count: lowBatteryCount,
      pending_review_count: pendingReviewHeadphones,
      needs_review_count: needsReviewCount,
      unresolved_alerts: unresolvedAlerts,
      today: todayStats,
      overdue_unreturned_batches: overdueUnreturnedBatches,
      followed_unreturned_batches: followedUnreturnedBatches,
      owner_summary: ownerSummary,
      cabinet_summary: cabinetSummary,
      pending_disposal_count: pendingDisposalCount,
      disposing_count: disposingCount,
      today_returned_count: todayStats.today_returned,
      today_disposed_count: todayDisposedCount,
      today_disposal_created_count: todayDisposalCreatedCount,
      abnormal_disposal_summary: abnormalDisposalSummary,
      disposal_conclusion_summary: disposalConclusionSummary,
      charging_headphone_count: chargingHeadphoneCount,
      batch_completion_stats: batchCompletionStats,
      overall_return_rate: overallReturnRate
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
