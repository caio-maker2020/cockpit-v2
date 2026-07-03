import React, { useMemo, useState } from "react";

/* ===========================================================
 * EmailThread — renderização da aba "MENSAGENS" do card.
 *
 * Reconstrói a conversa inteira a partir dos e-mails recebidos:
 * extrai mensagens citadas (Gmail "Em ... escreveu:" + ">" e
 * Outlook "De:/Enviada em:/Para:/Assunto:"), dedupe e ordena
 * cronologicamente. Só apresentação — não toca em queries.
 * =========================================================== */

// "asc" = mais antigo no topo (estilo WhatsApp). "desc" = mais recente no topo.
const ORDER: "asc" | "desc" = "asc";
const SAL_DOMAIN = "salexpress.com.br";

export interface EmailThreadAttachment {
  name: string;
  size?: number | null;
  url?: string | null;
  storagePath?: string | null;
  onOpen?: () => void;
}

export interface EmailThreadMessage {
  id?: string;
  fromName?: string;
  fromEmail?: string;
  to?: string[] | string;
  cc?: string[] | string;
  date?: string | Date;
  body?: string;
  attachments?: EmailThreadAttachment[];
  side?: "sal" | "cli";
}

/* ----------------- MAPEAMENTO ----------------- */
function normalize(raw: EmailThreadMessage) {
  const fromEmail = String(raw.fromEmail ?? "").trim();
  const fromName = raw.fromName ?? nameFromEmail(fromEmail);
  const to = asList(raw.to);
  const cc = asList(raw.cc);
  const date = new Date(raw.date ?? Date.now());
  const body = String(raw.body ?? "");
  const attachments = (raw.attachments ?? []).map((a) => ({
    name: a.name ?? "arquivo",
    size: a.size ?? null,
    url: a.url ?? null,
    storagePath: a.storagePath ?? null,
    onOpen: a.onOpen,
  }));
  return { fromName, fromEmail, to, cc, date, body, attachments, sideOverride: raw.side, _id: raw.id };
}

function asList(v: string[] | string | undefined | null): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(cleanRecipient).filter(Boolean);
  return String(v).split(/[;,]/).map(cleanRecipient).filter(Boolean);
}

function classify(email: string): "sal" | "cli" {
  return String(email).toLowerCase().includes(SAL_DOMAIN) ? "sal" : "cli";
}

/* ----------------- RECONSTRUÇÃO ----------------- */
const MONTHS: Record<string, number> = {
  jan: 0, fev: 1, mar: 2, abr: 3, mai: 4, jun: 5,
  jul: 6, ago: 7, set: 8, out: 9, nov: 10, dez: 11,
};

function parseBrDate(s: string): Date | null {
  const m = s.match(/(\d{1,2})\s+de\s+([a-zç]{3,})\.?\s+de\s+(\d{4})(?:\s+(?:às\s+)?(\d{1,2}):(\d{2}))?/i);
  if (!m) return null;
  const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (mon == null) return null;
  return new Date(+m[3], mon, +m[1], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
}

interface AttrInfo { name: string; email: string; date: Date | null }

function parseAttr(h: string): AttrInfo {
  const date = parseBrDate(h);
  let mo = h.match(/(?:De|From):\s*'?([^<\n]*?)'?\s*<\s*([^>]+?)\s*>/i);
  if (mo) return { name: (mo[1] || nameFromEmail(mo[2])).trim(), email: mo[2].trim(), date };
  mo = h.match(/(?:De|From):\s*([^\n<]+@[^\n<]+)/i);
  if (mo) return { name: nameFromEmail(mo[1].trim()), email: mo[1].trim(), date };
  const em = h.match(/<\s*([^>\s]+@[^>\s]+)\s*>/);
  const email = em ? em[1] : "";
  let name = "";
  const nm = h.match(/\d{1,2}:\d{2},\s*([^<]+?)\s*</);
  if (nm) name = nm[1].trim();
  else {
    const n2 = h.match(/,\s*([^,<]+?)\s*</);
    if (n2) name = n2[1].trim();
  }
  if (!name && email) name = nameFromEmail(email);
  return { name, email, date };
}

function cleanInline(t: string): string {
  return String(t)
    .replace(/\[cid:[^\]]+\]/gi, "")
    .replace(/@?'?([A-Za-zÀ-ú.\s]+?)'?\s*<mailto:[^>]+>/g, (_, n) => String(n).trim())
    .replace(/<mailto:[^>]+>/gi, "")
    .replace(/<[^@\s>]+@[^>]+>/g, "")
    .replace(/\bmailto:\S+/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripSig(t: string): { body: string; sig: string } {
  const sig = [
    /\n\s*atenciosamente\s*,?/i,
    /\n\s*att\.?\s*,?/i,
    /\n\s*abra[çc]os\s*,?/i,
    /\n--\s*\n?/,
    /\n\s*Sal\s*Express\s*[—-]\s*Relacionamento/i,
  ];
  let out = "";
  for (const re of sig) {
    const m = t.match(re);
    if (m && m.index != null) {
      out = t.slice(m.index).replace(/^\n/, "").trim();
      t = t.slice(0, m.index);
      break;
    }
  }
  return { body: t.trim(), sig: out };
}

interface PeelResult { clean: string; attr: AttrInfo | null; rest: string | null }

function peel(body: string): PeelResult {
  const lines = String(body).replace(/\r/g, "").split("\n");
  let aIdx = -1, qIdx = -1, oIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (qIdx < 0 && /^\s*>/.test(lines[i])) qIdx = i;
    if (
      oIdx < 0 &&
      /^\s*(De|From):\s/i.test(lines[i]) &&
      /(Enviada em|Sent|Data|Date)\s*:/i.test(lines.slice(i, i + 5).join(" "))
    ) oIdx = i;
    if (
      /^\s*(Em|On|O dia|Le|El)\b/i.test(lines[i]) &&
      /(escreveu|wrote|a écrit|escribió)\s*:/i.test(lines.slice(i, i + 5).join(" "))
    ) { aIdx = i; break; }
  }
  const cands: [string, number][] = ([["gmail", aIdx], ["quote", qIdx], ["outlook", oIdx]] as [string, number][])
    .filter((c) => c[1] >= 0)
    .sort((a, b) => a[1] - b[1]);
  if (!cands.length) return { clean: cleanInline(body), attr: null, rest: null };
  const [kind, cut] = cands[0];
  let headerEnd = cut;
  let attr: AttrInfo | null = null;
  let strip = false;
  if (kind === "gmail") {
    let h = cut;
    while (h < lines.length && !/(escreveu|wrote|a écrit|escribió)\s*:/i.test(lines[h])) h++;
    headerEnd = h;
    attr = parseAttr(lines.slice(cut, headerEnd + 1).join(" "));
    strip = true;
  } else if (kind === "outlook") {
    let h = cut;
    while (h < lines.length && !/^(Assunto|Subject)\s*:/i.test(lines[h]) && h < cut + 6) h++;
    headerEnd = h;
    attr = parseAttr(lines.slice(cut, headerEnd + 1).join("\n"));
    strip = false;
  } else {
    headerEnd = cut - 1;
    strip = true;
  }
  const clean = cleanInline(lines.slice(0, cut).join("\n"));
  let after = lines.slice(headerEnd + 1);
  if (strip) after = after.map((l) => l.replace(/^\s*>\s?/, ""));
  return { clean, attr, rest: after.join("\n").trim() };
}

interface Segment {
  author: string;
  email: string;
  date: Date;
  text: string;
  sig: string;
  depth: number;
  attachments?: EmailThreadAttachment[];
  to?: string[];
  cc?: string[];
  original?: boolean;
}

function explode(body: string, author: string, email: string, date: Date, depth = 0): Segment[] {
  const out: Segment[] = [];
  const { clean, attr, rest } = peel(body);
  const { body: b, sig } = stripSig(clean);
  if (b) out.push({ author, email, date, text: b, sig, depth });
  if (attr && rest && (attr.email || attr.name)) {
    const childDate = attr.date ?? new Date((date?.getTime?.() || Date.now()) - 60000);
    out.push(...explode(rest, attr.name, attr.email, childDate, depth + 1));
  }
  return out;
}

function dedupeKey(s: Segment): string {
  const t = s.text.slice(0, 60).replace(/\s+/g, " ").trim().toLowerCase();
  const ts = s.date ? Math.round(s.date.getTime() / 60000) : 0;
  return `${(s.email || s.author || "").toLowerCase()}|${ts}|${t}`;
}

/* ----------------- UTILS ----------------- */
function cleanRecipient(s: string): string {
  if (!s) return "";
  const str = String(s);
  const nameMatch = str.match(/^\s*'?([^<'"]+?)'?\s*</);
  if (nameMatch) return nameMatch[1].trim();
  const email = str.match(/[^<\s>]+@[^>\s]+/);
  return email ? nameFromEmail(email[0]) : str.trim();
}
function nameFromEmail(email: string): string {
  const local = String(email).split("@")[0] || "";
  return (
    local.replace(/[._-]+/g, " ").replace(/\d+/g, "").trim()
      .replace(/\b\w/g, (c) => c.toUpperCase()) || email
  );
}
function initials(name: string): string {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}
function fmtAbs(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} · ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtRel(d: Date): string {
  const h = Math.floor((Date.now() - d.getTime()) / 3.6e6);
  if (h < 1) return "agora há pouco";
  if (h < 24) return `há ${h}h`;
  const days = Math.floor(h / 24);
  return `há ${days} dia${days > 1 ? "s" : ""}`;
}
function fmtSize(n: number | null | undefined): string {
  if (n == null) return "";
  if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
  if (n >= 1024) return Math.round(n / 1024) + " KB";
  return n + " B";
}
function fmtDaySep(d: Date): string {
  return d.toLocaleDateString("pt-BR", {
    weekday: "long", day: "2-digit", month: "long", year: "numeric",
  }).toUpperCase();
}
function isImg(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name);
}

/* ----------------- ESTILO ----------------- */
const CSS = `
.set-wrap{--cli:#c8771b;--cli-bg:#fdf4e7;--cli-line:#eccfa3;--sal:#1f6f8b;--sal-bg:#eaf3f6;--sal-line:#b9d8e0;
  --card:#fff;--line:#e3ded3;--ink:#1a1a1a;--muted:#6b675f;--faint:#9a958c;--mono:'JetBrains Mono',ui-monospace,monospace;
  font-family:Inter,system-ui,sans-serif;color:var(--ink)}
.set-bar{display:flex;align-items:center;justify-content:space-between;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin-bottom:14px}
.set-bar .l{display:flex;align-items:center;gap:9px;font-size:12.5px;color:var(--muted)}
.set-sort{font-family:var(--mono);font-size:10px;letter-spacing:.5px;padding:4px 9px;border-radius:20px;background:#eef4ef;border:1px solid #cfe0d2;color:#3f6b46;font-weight:600}
.set-legend{display:flex;gap:14px;font-size:11px;color:var(--muted)}
.set-lg{display:inline-flex;align-items:center;gap:6px}
.set-sw{width:11px;height:11px;border-radius:3px}
.set-daysep{display:flex;align-items:center;gap:12px;margin:4px 0 16px;color:var(--faint);font-family:var(--mono);font-size:10px;letter-spacing:1.5px}
.set-daysep::before,.set-daysep::after{content:"";flex:1;height:1px;background:var(--line)}
.set-msg{display:flex;gap:13px;margin-bottom:16px;align-items:flex-start}
.set-msg.sal{flex-direction:row-reverse}
.set-av{width:40px;height:40px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;color:#fff;font-family:var(--mono)}
.set-av.cli{background:var(--cli)}.set-av.sal{background:var(--sal)}
.set-bub{flex:1;max-width:760px;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.set-msg.cli .set-bub{border-left:4px solid var(--cli)}
.set-msg.sal .set-bub{border-right:4px solid var(--sal)}
.set-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:12px 16px 10px;border-bottom:1px solid #f0ece2}
.set-who{display:flex;flex-direction:column;gap:3px}
.set-name{font-weight:600;font-size:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.set-rb{font-family:var(--mono);font-size:9px;letter-spacing:1px;font-weight:600;padding:2px 7px;border-radius:4px}
.set-rb.cli{background:var(--cli-bg);color:var(--cli);border:1px solid var(--cli-line)}
.set-rb.sal{background:var(--sal-bg);color:var(--sal);border:1px solid var(--sal-line)}
.set-addr{font-family:var(--mono);font-size:11px;color:var(--faint)}
.set-rcpt{font-size:11.5px;color:var(--muted);margin-top:2px}
.set-rcpt b{color:#4a463f;font-weight:600}
.set-when{text-align:right;flex-shrink:0}
.set-rel{font-size:12px;font-weight:600;color:#4a463f}
.set-abs{font-family:var(--mono);font-size:10.5px;color:var(--faint);margin-top:2px}
.set-latest{display:inline-block;margin-bottom:5px;font-family:var(--mono);font-size:9px;letter-spacing:1px;font-weight:600;color:#1f7a3f;background:#e8f5ec;border:1px solid #bfe3c8;border-radius:4px;padding:2px 7px}
.set-body{padding:13px 16px 6px;font-size:13.5px;line-height:1.6;color:#2b2925;white-space:pre-wrap}
.set-lead{font-weight:600;color:var(--ink)}
.set-toggle{display:inline-flex;align-items:center;gap:7px;font-family:var(--mono);font-size:10.5px;letter-spacing:.5px;color:var(--muted);background:#f6f3ec;border:1px solid var(--line);border-radius:6px;padding:6px 10px;margin:4px 16px 6px;cursor:pointer}
.set-toggle:hover{background:#efeadf}
.set-hidden{margin:0 16px 10px;padding:10px 12px;background:#faf8f3;border:1px dashed var(--line);border-radius:8px;font-size:12px;color:var(--muted);white-space:pre-wrap}
.set-foot{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:6px 16px 14px}
.set-att{display:inline-flex;align-items:center;gap:8px;background:#f7f4ec;border:1px solid var(--line);border-radius:8px;padding:6px 11px;font-size:12px;color:#3c3933;text-decoration:none;cursor:pointer}
.set-att.disabled{cursor:default;opacity:.7}
.set-att .ic{width:22px;height:22px;border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff;font-family:var(--mono)}
.set-att .ic.img{background:#3a8a5a}.set-att .ic.pdf{background:#c0392b}
.set-att .sz{color:var(--faint);font-size:11px;font-family:var(--mono)}
.set-empty{padding:40px;text-align:center;color:var(--faint);font-size:13px;border:1px dashed var(--line);border-radius:12px}
`;

/* ----------------- MENSAGEM ----------------- */
function MessageView({ m, isNewest, sideOverride }: { m: Segment; isNewest: boolean; sideOverride?: "sal" | "cli" }) {
  const [showSig, setShowSig] = useState(false);
  const side: "sal" | "cli" = sideOverride ?? classify(m.email);
  const role = side === "sal" ? "SAL·EXPRESS · RELACIONAMENTO" : "CLIENTE";
  const lines = String(m.text).split("\n").filter((l) => l.trim());

  return (
    <div className={`set-msg ${side}`}>
      <div className={`set-av ${side}`}>{initials(m.author)}</div>
      <div className="set-bub">
        <div className="set-head">
          <div className="set-who">
            {isNewest && side === "cli" && (
              <span className="set-latest">● ÚLTIMA RESPOSTA · AGUARDANDO VOCÊ</span>
            )}
            <div className="set-name">
              {m.author} <span className={`set-rb ${side}`}>{role}</span>
            </div>
            {m.email && <div className="set-addr">{m.email}</div>}
            {((m.to?.length ?? 0) > 0 || (m.cc?.length ?? 0) > 0) && (
              <div className="set-rcpt">
                {m.to && m.to.length > 0 && (<><b>Para:</b> {m.to.join(", ")} </>)}
                {m.cc && m.cc.length > 0 && (<>· <b>Cc:</b> {m.cc.join(", ")}</>)}
              </div>
            )}
          </div>
          <div className="set-when">
            <div className="set-rel">{fmtRel(m.date)}</div>
            <div className="set-abs">{fmtAbs(m.date)}</div>
          </div>
        </div>

        <div className="set-body">
          {lines.length === 0 ? (
            <span style={{ color: "var(--faint)", fontStyle: "italic" }}>(sem texto)</span>
          ) : (
            lines.map((l, i) => (
              <div key={i} className={i === 0 ? "set-lead" : undefined}>{l}</div>
            ))
          )}
        </div>

        {m.sig && (
          <>
            <button className="set-toggle" onClick={() => setShowSig((s) => !s)}>
              {showSig ? "▴ ocultar assinatura" : "▾ mostrar assinatura"}
            </button>
            {showSig && <div className="set-hidden">{m.sig}</div>}
          </>
        )}

        {m.attachments && m.attachments.length > 0 && (
          <div className="set-foot">
            {m.attachments.map((a, i) => {
              const img = isImg(a.name);
              const clickable = !!(a.url || a.onOpen);
              const handle = (e: React.MouseEvent) => {
                if (a.onOpen) { e.preventDefault(); a.onOpen(); }
              };
              const inner = (
                <>
                  <span className={`ic ${img ? "img" : "pdf"}`}>{img ? "IMG" : "PDF"}</span>
                  <span>{a.name}</span>
                  {a.size != null && <span className="sz">{fmtSize(a.size)}</span>}
                </>
              );
              if (a.url) {
                return (
                  <a key={i} className="set-att" href={a.url} target="_blank" rel="noopener noreferrer" onClick={handle}>
                    {inner}
                  </a>
                );
              }
              return (
                <span
                  key={i}
                  className={`set-att ${clickable ? "" : "disabled"}`}
                  onClick={clickable ? handle : undefined}
                  role={clickable ? "button" : undefined}
                >
                  {inner}
                </span>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------- THREAD ----------------- */
export default function EmailThread({ messages = [] }: { messages?: EmailThreadMessage[] }) {
  const { items, nCli, nSal, newestKey, overrides } = useMemo(() => {
    const pool: Segment[] = [];
    const overrides = new Map<string, "sal" | "cli">();
    for (const raw of messages) {
      const r = normalize(raw);
      const segs = explode(r.body, r.fromName, r.fromEmail, r.date);
      if (segs[0]) {
        segs[0].attachments = r.attachments;
        segs[0].to = r.to;
        segs[0].cc = r.cc;
        segs[0].original = true;
        if (r.sideOverride) overrides.set(dedupeKey(segs[0]), r.sideOverride);
      }
      pool.push(...segs);
    }
    const map = new Map<string, Segment>();
    for (const s of pool) {
      const k = dedupeKey(s);
      const ex = map.get(k);
      if (!ex) map.set(k, s);
      else if (s.original && !ex.original) map.set(k, { ...s, sig: s.sig || ex.sig });
    }
    let arr = [...map.values()];
    arr.sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));
    const newest = arr[arr.length - 1];
    const newestKey = newest ? dedupeKey(newest) : null;
    if (ORDER === "desc") arr = arr.reverse();
    const nCli = arr.filter((s) => (overrides.get(dedupeKey(s)) ?? classify(s.email)) === "cli").length;
    return { items: arr, nCli, nSal: arr.length - nCli, newestKey, overrides };
  }, [messages]);

  let lastDay: string | null = null;

  return (
    <div className="set-wrap">
      <style>{CSS}</style>
      <div className="set-bar">
        <div className="l">
          <span className="set-sort">
            {ORDER === "asc" ? "↑ ORDEM CRONOLÓGICA" : "↓ MAIS RECENTE PRIMEIRO"}
          </span>
          <span>
            {items.length} mensagens · {nCli} do cliente · {nSal} da Sal·Express
          </span>
        </div>
        <div className="set-legend">
          <span className="set-lg"><span className="set-sw" style={{ background: "#c8771b" }} /> Cliente</span>
          <span className="set-lg"><span className="set-sw" style={{ background: "#1f6f8b" }} /> Sal·Express</span>
        </div>
      </div>

      {items.length === 0 && <div className="set-empty">Sem mensagens neste caso.</div>}

      {items.map((m, i) => {
        const day = m.date ? m.date.toDateString() : "";
        const showSep = day !== lastDay;
        lastDay = day;
        const k = dedupeKey(m);
        return (
          <div key={i}>
            {showSep && m.date && <div className="set-daysep">{fmtDaySep(m.date)}</div>}
            <MessageView m={m} isNewest={k === newestKey} sideOverride={overrides.get(k)} />
          </div>
        );
      })}
    </div>
  );
}

/* ===========================================================
 * MAPEAMENTO em normalize():
 *   fromName  ← raw.fromName
 *   fromEmail ← raw.fromEmail
 *   to/cc     ← raw.to / raw.cc (string ou array)
 *   date      ← raw.date
 *   body      ← raw.body
 *   attachments ← raw.attachments (name, size, url, storagePath, onOpen)
 *   side      ← raw.side (override opcional)
 *
 * DADOS QUE NÃO EXISTEM HOJE (mantidos como fallback / vazios):
 *   - Assunto (subject) por mensagem
 *   - Destinatários (To/Cc) para mensagens reconstruídas a partir de citações
 *   - Anexos para mensagens reconstruídas (só ficam no e-mail original)
 *   - Metadados do remetente reconstruído além do que aparece no header citado
 * =========================================================== */
