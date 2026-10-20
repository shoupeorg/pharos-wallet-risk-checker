export async function persistReport(db, report, requestKey) {
  const existing = await db.prepare("SELECT payload FROM reports WHERE request_key=?").bind(requestKey).first();
  if (existing) return { ...JSON.parse(existing.payload), replayed: true, historical: true };
  const payload = JSON.stringify(report);
  await db.prepare("INSERT INTO reports (id,request_key,target,risk_level,coverage_status,captured_at,engine_version,payload) VALUES (?,?,?,?,?,?,?,?)")
    .bind(report.id, requestKey, report.snapshot.target, report.analysis.riskLevel, report.analysis.coverageStatus, report.capturedAt, report.analysis.engineVersion, payload).run();
  return report;
}
