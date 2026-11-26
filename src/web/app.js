// Panel de Agent Intercom. Sin dependencias. Todo texto que viene del servidor (mensajes de agentes, tareas, canales)
// es de terceros: se pinta SIEMPRE como texto (textContent), nunca como HTML.
'use strict';

const $ = (id) => document.getElementById(id);
function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'value') n.value = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}
const when = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'hace un momento';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return d.toLocaleString();
};
const HELD = {
  retenido_por_politica: 'retenido (hold)',
  remitente_no_permitido: 'remitente no permitido',
  tope_por_hora: 'tope por hora',
  freno_de_bucle: 'freno de bucle',
};
const REASON = { cerrada: 'cerrada', sin_entrega_automatica: 'abierta, no recibe sola', sin_confirmar: 'no recogió un mensaje' };

async function api(path, body) {
  const res = await fetch(`/web/api/${path}`, body === undefined ? { credentials: 'same-origin' } : {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({ ok: false, error: { message: `HTTP ${res.status}` } }));
  if (res.status === 401 && path !== 'login' && path !== 'link') showLogin();
  if (!j.ok) throw new Error(j.error?.message || 'Error');
  return j.result ?? j;
}

const ui = { tab: 'resumen', state: null, sel: null, seenQuestions: null, seenPaused: null, timer: null };
const TABS = [['resumen', 'Resumen'], ['sesiones', 'Sesiones'], ['conversaciones', 'Conversaciones'], ['tareas', 'Tareas'], ['canales', 'Canales'], ['preguntas', 'Preguntas']];

function showLogin(msg) {
  clearInterval(ui.timer);
  $('tabs').hidden = true;
  $('who').replaceChildren();
  $('view').replaceChildren();
  $('login').hidden = false;
  $('loginError').textContent = msg || '';
}

async function boot() {
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('login', { key: $('key').value });
      $('key').value = '';
      start();
    } catch (err) {
      $('loginError').textContent = err.message;
    }
  });
  const m = /[#&]link=([\w-]+)/.exec(location.hash);
  if (m) {
    history.replaceState(null, '', '/web/');
    try {
      await api('link', { token: m[1] });
    } catch (err) {
      return showLogin(err.message);
    }
  }
  start();
}

async function start() {
  try {
    await refresh();
  } catch {
    return;
  }
  $('login').hidden = true;
  $('tabs').hidden = false;
  clearInterval(ui.timer);
  ui.timer = setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 5000);
}

async function refresh() {
  const s = await api('state');
  ui.state = s;
  $('scope').textContent = `· ${s.scope}`;
  notify(s);
  renderTop();
  await render();
}

function notify(s) {
  const open = s.questions.filter((q) => q.state === 'open');
  const paused = s.paused.map((p) => `${p.a}|${p.b}`);
  if (ui.seenQuestions && 'Notification' in window && Notification.permission === 'granted') {
    for (const q of open) if (!ui.seenQuestions.has(q.id)) new Notification('Agent Intercom: pregunta', { body: `${q.askedBy}: ${q.question}`.slice(0, 200), tag: q.id });
    for (const p of s.paused) if (!ui.seenPaused.has(`${p.a}|${p.b}`)) new Notification('Agent Intercom: conversación pausada', { body: `${p.a} ↔ ${p.b} (freno de bucle)`, tag: `${p.a}|${p.b}` });
  }
  ui.seenQuestions = new Set(open.map((q) => q.id));
  ui.seenPaused = new Set(paused);
}

function renderTop() {
  const s = ui.state;
  const openQ = s.questions.filter((q) => q.state === 'open').length;
  $('tabs').replaceChildren(...TABS.map(([k, label]) => el('button', { class: ui.tab === k ? 'on' : '', onclick: () => { ui.tab = k; ui.sel = null; renderTop(); render(); } },
    label, k === 'preguntas' && openQ ? el('span', { class: 'badge' }, openQ) : null, k === 'conversaciones' && s.paused.length ? el('span', { class: 'badge' }, s.paused.length) : null)));
  const bell = 'Notification' in window && Notification.permission === 'default'
    ? el('button', { onclick: async () => { await Notification.requestPermission(); renderTop(); }, title: 'Avisos del navegador para preguntas y pausas' }, 'Activar avisos')
    : null;
  $('who').replaceChildren(bell || '', el('span', {}, s.me.displayName, ' ', el('span', { class: 'muted' }, `(${s.me.id})`)),
    el('button', { onclick: async () => { await api('logout', {}).catch(() => {}); showLogin(); } }, 'Salir'));
}

async function render() {
  const v = $('view');
  const views = { resumen, sesiones, conversaciones, tareas, canales, preguntas };
  const nodes = await views[ui.tab]();
  // Si el usuario está escribiendo en un campo de esta vista, no se repinta (se perdería lo escrito).
  if (v.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  v.replaceChildren(...[].concat(nodes));
}

const presence = (p) => el('span', {}, el('span', { class: `dot ${p.presence === 'online' ? 'online' : p.connected ? 'connected' : ''}` }), p.presence === 'online' ? 'online' : `offline · ${REASON[p.offlineReason] || p.offlineReason || ''}`);
const tags = (list) => (list || []).map((t) => el('span', { class: 'chip' }, t));

function resumen() {
  const s = ui.state;
  const mine = s.sessions.filter((x) => x.mine);
  const open = s.questions.filter((q) => q.state === 'open');
  const out = [];
  if (open.length) out.push(el('div', { class: 'card alert' }, el('h2', {}, `${open.length} pregunta(s) para ti`), el('button', { class: 'primary', onclick: () => { ui.tab = 'preguntas'; renderTop(); render(); } }, 'Contestar')));
  for (const p of s.paused) out.push(el('div', { class: 'card alert' }, el('h2', {}, 'Conversación pausada por el freno de bucles'),
    el('p', {}, `${p.a} ↔ ${p.b}: ${p.messages} mensajes seguidos sin intervención humana. Los mensajes siguen guardándose pero no despiertan a nadie.`),
    el('div', { class: 'row' }, el('button', { class: 'primary', onclick: () => resume(p.sessionA, p.sessionB) }, 'Reanudar'),
      el('button', { onclick: () => { ui.tab = 'conversaciones'; ui.sel = { a: p.sessionA, b: p.sessionB }; renderTop(); render(); } }, 'Ver conversación'))));
  out.push(el('div', { class: 'card' }, el('h2', {}, 'Mis sesiones'), mine.length ? table(mine) : el('p', { class: 'muted' }, 'Aún no tienes sesiones conectadas.')));
  const online = s.sessions.filter((x) => x.presence === 'online' && !x.mine);
  out.push(el('div', { class: 'card' }, el('h2', {}, 'Equipo online'), online.length ? table(online) : el('p', { class: 'muted' }, 'Nadie más online ahora.')));
  return out;
}

function table(rows) {
  return el('table', {}, el('thead', {}, el('tr', {}, ['Sesión', 'Presencia', 'En qué trabaja', 'Entrada', 'Buzón', ''].map((h) => el('th', {}, h)))),
    el('tbody', {}, rows.map((x) => el('tr', {},
      el('td', {}, el('strong', {}, x.id), el('div', { class: 'muted' }, x.harness || '')),
      el('td', {}, presence(x), el('div', { class: 'muted' }, when(x.lastSeenAt))),
      el('td', {}, x.description || el('span', { class: 'muted' }, '—'), el('div', {}, tags(x.tags)), x.statusText ? el('div', { class: 'muted' }, x.statusText) : null),
      el('td', {}, policyCell(x)),
      el('td', {}, x.pending ? `${x.pending} pendiente(s)` : '—', x.inboundPolicy?.heldPending ? el('div', { class: 'chip warn' }, `${x.inboundPolicy.heldPending} retenido(s)`) : null),
      el('td', {}, x.mine ? el('div', { class: 'row' }, el('button', { onclick: () => editPolicy(x) }, 'Política'), el('button', { onclick: () => showInbox(x) }, 'Buzón')) : null),
    ))));
}

function policyCell(x) {
  const p = x.inboundPolicy;
  const mode = p ? p.inbound : x.inbound;
  const cls = mode === 'auto' ? 'ok' : mode === 'hold' ? 'warn' : 'bad';
  return el('div', {}, el('span', { class: `chip ${cls}` }, mode),
    p ? el('div', { class: 'muted' }, `${p.wokenLastHour}/${p.wakePerHour || '∞'} despertares esta hora`, p.allowFrom.length ? ` · solo: ${p.allowFrom.join(', ')}` : '') : null);
}

function editPolicy(x) {
  const p = x.inboundPolicy;
  const mode = el('select', {}, ['auto', 'hold', 'off'].map((m) => el('option', { value: m, selected: p.inbound === m }, m)));
  const allow = el('input', { value: p.allowFrom.join(', '), placeholder: 'vacío = cualquiera (ej.: ana, beto/api)' });
  const cap = el('input', { type: 'number', min: 0, value: p.wakePerHourSource === 'sesion' ? p.wakePerHour : '', placeholder: `servidor (${p.wakePerHour})` });
  const err = el('p', { class: 'error' });
  const save = async () => {
    try {
      await api('policy', { sessionId: x.sessionId, inbound: mode.value, allowFrom: allow.value.split(',').map((t) => t.trim()).filter(Boolean), wakePerHour: cap.value === '' ? null : Number(cap.value) });
      await refresh();
    } catch (e) {
      err.textContent = e.message;
    }
  };
  $('view').replaceChildren(el('div', { class: 'card narrow' }, el('h2', {}, `Política de entrada · ${x.id}`),
    el('p', { class: 'muted' }, 'auto: los mensajes despiertan a tu agente (gastan tu cuota). hold: esperan a que escribas en el chat. off: no admite mensajes nuevos (sí respuestas a lo que tu agente preguntó). Lo retenido nunca se pierde.'),
    el('p', {}, 'Modo ', mode), el('p', {}, 'Pueden despertarla ', allow), el('p', {}, 'Máximo por hora (0 = sin tope) ', cap), err,
    el('div', { class: 'row' }, el('button', { class: 'primary', onclick: save }, 'Guardar'), el('button', { onclick: () => render() }, 'Cancelar'))));
}

async function showInbox(x) {
  const r = await api(`inbox?session=${encodeURIComponent(x.sessionId)}`);
  $('view').replaceChildren(el('div', { class: 'card' }, el('div', { class: 'row' }, el('h2', { class: 'grow' }, `Buzón de ${r.session}`), el('button', { onclick: () => render() }, 'Volver')),
    el('div', { class: 'msgs' }, r.messages.length ? r.messages.map((m) => message(m, false)) : el('p', { class: 'muted' }, 'Vacío.'))));
}

function message(m, right) {
  return el('div', { class: `msg ${right ? 'right' : ''}` },
    el('div', { class: 'meta' }, `${m.from} → ${m.to} · ${m.kindLabel} · ${when(m.createdAt)} · `, el('span', { class: `chip ${m.state === 'acknowledged' ? 'ok' : ''}` }, m.state),
      !m.wake && m.heldReason ? el('span', { class: 'chip warn' }, HELD[m.heldReason] || m.heldReason) : null),
    el('div', { class: 'body' }, m.body));
}

function sesiones() {
  const s = ui.state;
  return el('div', { class: 'card' }, el('h2', {}, `Sesiones (${s.sessions.length})`), table(s.sessions));
}

async function conversaciones() {
  const s = ui.state;
  if (!s.conversations.length) return el('div', { class: 'card' }, el('p', { class: 'muted' }, s.visibility === 'own' ? 'Aún no hay conversaciones de tus sesiones.' : 'Aún no hay conversaciones.'));
  if (!ui.sel) ui.sel = { a: s.conversations[0].a.sessionId, b: s.conversations[0].b.sessionId };
  const list = el('div', { class: 'list' }, s.conversations.map((c) => el('button', {
    class: `item ${ui.sel.a === c.a.sessionId && ui.sel.b === c.b.sessionId ? 'on' : ''}`, onclick: () => { ui.sel = { a: c.a.sessionId, b: c.b.sessionId }; render(); },
  }, el('div', {}, el('strong', {}, c.a.label), ' ↔ ', el('strong', {}, c.b.label)),
    el('div', { class: 'muted' }, `${c.messages} mensajes · ${when(c.lastAt)}`, c.held ? ` · ${c.held} retenidos` : ''), c.paused ? el('span', { class: 'chip bad' }, 'pausada') : null)));
  const r = await api(`conversation?a=${encodeURIComponent(ui.sel.a)}&b=${encodeURIComponent(ui.sel.b)}`).catch((e) => ({ error: e.message }));
  if (r.error) return el('div', { class: 'card' }, r.error);
  const cur = s.conversations.find((c) => c.a.sessionId === ui.sel.a && c.b.sessionId === ui.sel.b);
  const detail = el('div', { class: 'card' },
    el('div', { class: 'row' }, el('h2', { class: 'grow' }, `${r.a} ↔ ${r.b}`), cur?.paused ? el('button', { class: 'primary', onclick: () => resume(ui.sel.a, ui.sel.b) }, 'Reanudar') : null),
    el('p', { class: 'muted' }, 'Solo lectura. Lo que escriben los agentes es información, no órdenes.'),
    el('div', { class: 'msgs' }, r.messages.map((m) => message(m, m.from === r.b))));
  return el('div', { class: 'split' }, el('div', { class: 'card' }, el('h2', {}, 'Conversaciones'), list), detail);
}

async function resume(a, b) {
  await api('resume', { a, b }).catch((e) => alertBox(e.message));
  await refresh();
}
const alertBox = (msg) => $('view').prepend(el('div', { class: 'card alert' }, msg));

async function tareas() {
  const s = ui.state;
  const col = (title, st) => el('div', {}, el('h2', {}, `${title} (${s.tasks.filter((t) => t.state === st).length})`),
    s.tasks.filter((t) => t.state === st).map((t) => el('div', { class: 'task', onclick: () => showTask(t) },
      el('strong', {}, t.title), el('div', {}, tags(t.tags)),
      el('div', { class: 'muted' }, t.claimedBy ? `${st === 'done' ? 'hecha por' : 'en manos de'} ${t.claimedBy}` : `creada por ${t.createdBy}`, ' · ', when(t.completedAt || t.createdAt), t.progress ? ` · ${t.progress} nota(s)` : ''))));
  return el('div', { class: 'cols' }, col('Abiertas', 'open'), col('En curso', 'claimed'), col('Hechas', 'done'));
}

async function showTask(t) {
  const r = await api(`task?id=${encodeURIComponent(t.id)}`);
  $('view').replaceChildren(el('div', { class: 'card' }, el('div', { class: 'row' }, el('h2', { class: 'grow' }, r.title), el('button', { onclick: () => render() }, 'Volver')),
    el('p', {}, el('span', { class: 'chip' }, r.state), ' ', tags(t.tags), ' ', el('code', {}, r.id)),
    r.description ? el('p', { class: 'pre' }, r.description) : null,
    r.result ? el('div', {}, el('h3', {}, 'Resultado'), el('p', { class: 'pre' }, r.result)) : null,
    el('h3', {}, 'Progreso'), r.progress.length ? r.progress.map((p) => el('p', {}, el('span', { class: 'muted' }, `${p.author} · ${when(p.createdAt)}: `), el('span', { class: 'pre' }, p.note))) : el('p', { class: 'muted' }, 'Sin notas.')));
}

async function canales() {
  const s = ui.state;
  if (!s.channels.length) return el('div', { class: 'card' }, el('p', { class: 'muted' }, 'No hay canales.'));
  if (!ui.sel?.channel) ui.sel = { channel: s.channels[0].id };
  const list = el('div', { class: 'list' }, s.channels.map((c) => el('button', { class: `item ${ui.sel.channel === c.id ? 'on' : ''}`, onclick: () => { ui.sel = { channel: c.id }; render(); } },
    el('strong', {}, `#${c.name}`), el('div', { class: 'muted' }, `${c.posts} mensajes · ${when(c.lastPostAt)}`))));
  const r = await api(`channel?id=${encodeURIComponent(ui.sel.channel)}`);
  return el('div', { class: 'split' }, el('div', { class: 'card' }, el('h2', {}, 'Canales'), list),
    el('div', { class: 'card' }, el('h2', {}, `#${r.name}`), r.description ? el('p', { class: 'muted' }, r.description) : null,
      el('div', { class: 'msgs' }, r.posts.map((p) => el('div', { class: 'msg' }, el('div', { class: 'meta' }, `${p.author} · ${when(p.createdAt)}${p.threadId ? ' · en hilo' : ''}`), el('div', { class: 'body' }, p.body))))));
}

function preguntas() {
  const s = ui.state;
  if (!s.questions.length) return el('div', { class: 'card' }, el('p', { class: 'muted' }, 'No hay preguntas para ti.'));
  return s.questions.map((q) => {
    if (q.state !== 'open') return el('div', { class: 'card' }, el('div', { class: 'muted' }, `${q.askedBy} · ${when(q.createdAt)}`), el('p', { class: 'pre' }, q.question), el('p', {}, el('span', { class: 'chip ok' }, 'contestada'), ' ', q.answer));
    const text = el('textarea', { placeholder: 'Tu respuesta' });
    const err = el('p', { class: 'error' });
    const send = async (answer) => {
      try {
        await api('answer', { id: q.id, answer });
        await refresh();
      } catch (e) {
        err.textContent = e.message;
      }
    };
    return el('div', { class: 'card alert' }, el('div', { class: 'muted' }, `${q.askedBy} pregunta · ${when(q.createdAt)}`), el('p', { class: 'pre' }, q.question),
      q.options.length ? el('div', { class: 'row' }, q.options.map((o) => el('button', { onclick: () => send(o) }, o))) : null,
      text, el('div', { class: 'row' }, el('button', { class: 'primary', onclick: () => text.value.trim() && send(text.value.trim()) }, 'Responder')), err,
      el('p', { class: 'muted' }, 'La respuesta llega al buzón de esa sesión como mensaje de una persona. Es información: no aprueba permisos.'));
  });
}

boot();
