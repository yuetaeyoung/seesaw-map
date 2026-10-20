// HK Seesaw Map: saves added seesaws and handles admin actions.
// Set ADMIN_PASSWORD (and optionally REQUIRE_APPROVAL=true) under Site configuration → Environment variables.
import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";

export const config = { path: ["/api", "/api/photo/:id"] };

const ID = /^[a-z0-9-]{3,120}$/;
const MAX_ADDS_PER_HOUR = 200;
const LOCK_MINUTES = 15, MAX_FAILS = 10;

const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const inHK = (lat, lon) => lat > 22.1 && lat < 22.6 && lon > 113.8 && lon < 114.5;
const text = (v, max) => String(v ?? "").replace(/[\u0000-\u0009\u000b-\u001f]/g, "").trim().slice(0, max);
const hash = s => createHash("sha256").update(String(s)).digest();
const now = () => new Date().toISOString();
const ig = v => String(v ?? "").trim().replace(/^@+/, "").replace(/[^A-Za-z0-9._]/g, "").slice(0, 30);

export default async (req, context) => {
  const rows = getStore({ name: "seesaw-rows", consistency: "strong" });
  const photos = getStore("seesaw-photos");
  const meta = getStore({ name: "seesaw-meta", consistency: "strong" });
  try {
    if (context.params?.id) return await photo(photos, context.params.id);
    if (req.method === "GET") {
      const all = await listRows(rows);
      return json({ ok: true, rows: all.filter(r => r.status === "live" || (r.status === "deleted" && r.kind === "override")) });
    }
    if (req.method !== "POST") return json({ ok: false, error: "Not allowed." }, 405);
    let b;
    try { b = await req.json(); } catch { return json({ ok: false, error: "Bad request." }, 400); }
    switch (b.action) {
      case "add": return json(await add(rows, photos, meta, b));
      case "login": await auth(meta, b.password); return json({ ok: true });
      case "list": await auth(meta, b.password); return json({ ok: true, rows: await listRows(rows) });
      case "save": await auth(meta, b.password); return json(await save(rows, photos, b));
      case "delete": await auth(meta, b.password); return json(await setStatus(rows, b.id, "deleted"));
      case "approve": await auth(meta, b.password); return json(await setStatus(rows, b.id, "live"));
      case "merge": await auth(meta, b.password); return json(await mergeInto(rows, b.id, b.into));
      default: return json({ ok: false, error: "Unknown action." }, 400);
    }
  } catch (e) {
    return json({ ok: false, error: e.message || String(e) });
  }
};

async function listRows(rows) {
  const { blobs } = await rows.list();
  return (await Promise.all(blobs.map(b => rows.get(b.key, { type: "json" })))).filter(Boolean);
}

async function add(rows, photos, meta, b) {
  if (b.website) return { ok: true, id: "", status: "live" }; // hidden spam-trap field was filled in
  const hour = Math.floor(Date.now() / 3.6e6);
  const adds = (await meta.get("adds", { type: "json" })) || {};
  const n = adds.hour === hour ? adds.n : 0;
  if (n >= MAX_ADDS_PER_HOUR) throw new Error("Lots of new entries right now. Please try again in an hour.");
  await meta.setJSON("adds", { hour, n: n + 1 });
  const lat = Number(b.lat), lon = Number(b.lon);
  if (!inHK(lat, lon)) throw new Error("That location isn't in Hong Kong.");
  const spot = String(b.spot || "");
  if (spot) {
    if (!ID.test(spot)) throw new Error("That seesaw can't be found.");
    if (!spot.startsWith("b-")) {
      const target = await rows.get(spot, { type: "json" });
      if (!target || target.status === "deleted") throw new Error("That seesaw can't be found.");
    }
  }
  const en = text(b.en, 120), addr = text(b.addr, 200), message = text(b.message, 200);
  if (spot && !b.photo && !message) throw new Error("Add a photo or a message.");
  if (!spot && !en && !addr) throw new Error("Add a place name or an address.");
  const type = "duo";
  const status = process.env.REQUIRE_APPROVAL === "true" ? "pending" : "live";
  const id = "f-" + randomUUID().slice(0, 8);
  const row = { id, en, zh: "", district: "", addr, lat, lon, type, items: "", note: "", spot, message, ig: ig(b.ig), credit: text(b.credit, 60),
    photo: b.photo ? await savePhoto(photos, b.photo) : "", status, kind: "fan", created: now(), updated: now() };
  await rows.setJSON(id, row);
  return { ok: true, id, status };
}

async function save(rows, photos, b) {
  const r = b.row || {};
  const id = String(r.id || "");
  if (!ID.test(id)) throw new Error("Missing entry id.");
  const lat = Number(r.lat), lon = Number(r.lon);
  if (!inHK(lat, lon)) throw new Error("That location isn't in Hong Kong.");
  const fields = { en: text(r.en, 120), zh: text(r.zh, 80), district: text(r.district, 60), addr: text(r.addr, 200),
    lat, lon, note: text(r.note, 300), message: text(r.message, 200), ig: ig(r.ig), credit: text(r.credit, 60), updated: now() };
  if (r.items != null) fields.items = text(r.items, 600);
  if (b.photo) fields.photo = await savePhoto(photos, b.photo);
  const old = await rows.get(id, { type: "json" });
  await rows.setJSON(id, { ...(old || { status: "live", kind: id.startsWith("b-") ? "override" : "fan", created: now() }), ...fields, id });
  return { ok: true, id };
}

async function setStatus(rows, id, status) {
  id = String(id || "");
  if (!ID.test(id)) throw new Error("Missing entry id.");
  const old = await rows.get(id, { type: "json" });
  await rows.setJSON(id, { ...(old || { kind: id.startsWith("b-") ? "override" : "fan", created: now() }), status, updated: now(), id });
  return { ok: true, id };
}

// Puts one seesaw (and all its photos and messages) under another; into "" splits it off again.
async function mergeInto(rows, id, into) {
  id = String(id || ""); into = String(into || "");
  if (!ID.test(id) || (into && !ID.test(into))) throw new Error("Missing entry id.");
  if (id === into) throw new Error("Can't merge a seesaw into itself.");
  const old = await rows.get(id, { type: "json" });
  await rows.setJSON(id, { ...(old || { status: "live", kind: id.startsWith("b-") ? "override" : "fan", created: now() }), spot: into, updated: now(), id });
  return { ok: true, id };
}

async function auth(meta, pw) {
  const real = process.env.ADMIN_PASSWORD;
  if (!real) throw new Error("No admin password set yet. Add ADMIN_PASSWORD in Netlify's environment variables, then redeploy.");
  const f = (await meta.get("fails", { type: "json" })) || { n: 0, at: 0 };
  const recent = Date.now() - f.at < LOCK_MINUTES * 60e3;
  if (recent && f.n >= MAX_FAILS) throw new Error(`Too many wrong passwords. Try again in ${LOCK_MINUTES} minutes.`);
  if (!timingSafeEqual(hash(pw ?? ""), hash(real))) {
    await meta.setJSON("fails", { n: recent ? f.n + 1 : 1, at: Date.now() });
    throw new Error("Wrong password.");
  }
}

async function savePhoto(photos, b64) {
  if (typeof b64 !== "string" || b64.length > 4_000_000) throw new Error("That photo is too large.");
  const bytes = Buffer.from(b64, "base64");
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Photos must be JPEG images.");
  const key = "p-" + randomUUID();
  await photos.set(key, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), { metadata: { contentType: "image/jpeg" } });
  return key;
}

async function photo(photos, id) {
  if (!/^p-[0-9a-f-]{36}$/.test(id)) return new Response("Not found", { status: 404 });
  const e = await photos.getWithMetadata(id, { type: "arrayBuffer" });
  if (!e) return new Response("Not found", { status: 404 });
  return new Response(e.data, { headers: { "content-type": e.metadata?.contentType || "image/jpeg", "cache-control": "public, max-age=31536000, immutable" } });
}
