'use strict';
// Reports: members tell the SMs about a bug or about someone abusing the system. Only Advocates (creation password) can read them.
import { fail } from './engine.mjs';
import { who, str } from './items.mjs';

const view = r => ({ id: r.id, member: r.member_name, kind: r.kind, about: r.about, text: r.text, createdAt: r.created_at, done: !!r.done });

export async function handleReports(request, db, path, { json, input, rate, ip, checkCreate }) {
  const post = request.method === 'POST';

  if (post && path.startsWith('/reports/admin/')) {
    await rate(db, 'report-admin:' + ip, 60);
    const d = await input(request); checkCreate(d.adminPassword);
    if (path === '/reports/admin/list') {
      const { results } = await db.prepare('SELECT * FROM reports ORDER BY done, id DESC LIMIT 200').all();
      return json({ reports: results.map(view) });
    }
    if (path === '/reports/admin/done') {
      const r = await db.prepare('UPDATE reports SET done = 1 - done WHERE id = ?').bind(Number(d.id)).run();
      if (r.meta.changes !== 1) fail('That report is already gone.', 404);
      return json({ ok: true });
    }
    if (path === '/reports/admin/delete') {
      const r = await db.prepare('DELETE FROM reports WHERE id = ?').bind(Number(d.id)).run();
      if (r.meta.changes !== 1) fail('That report is already gone.', 404);
      return json({ deleted: true });
    }
    fail('Endpoint not found.', 404);
  }

  const me = await who(db, request);
  if (post && path === '/reports') {
    await rate(db, 'report:' + me.id, 10);
    const d = await input(request);
    if (!['bug', 'abuse'].includes(d.kind)) fail('Choose bug or abuse.');
    const about = str(d.about, 'Who it is about', 40, false), text = str(d.text, 'What happened', 500);
    const open = await db.prepare('SELECT count(*) AS n FROM reports WHERE member_id = ? AND done = 0').bind(me.id).first();
    if (open.n >= 10) fail('You already have several open reports. Please wait for the SMs to look at them.', 429);
    await db.prepare("DELETE FROM reports WHERE done = 1 AND created_at < ?").bind(new Date(Date.now() - 30 * 86400000).toISOString()).run();
    const total = await db.prepare('SELECT count(*) AS n FROM reports').first();
    if (total.n >= 500) fail('The report box is full right now. Please tell an Advocate in game.', 503);
    await db.prepare('INSERT INTO reports (member_id, member_name, kind, about, text, created_at) VALUES (?,?,?,?,?,?)').bind(me.id, me.name, d.kind, about, text, new Date().toISOString()).run();
    return json({ sent: true }, 201);
  }
  fail('Endpoint not found.', 404);
}
