import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient } from '@supabase/supabase-js';
import {
  Activity, AlertTriangle, ArrowRight, Building2, Check, CheckCircle2, ChevronRight, CircleDot, ClipboardCheck,
  ArrowLeft, Box, Clock3, FlaskConical, LayoutGrid, LogOut, MousePointerClick, Radio, RefreshCw, Server, Settings, Settings2, Wrench, X,
} from 'lucide-react';
import './styles.css';

const tabs = [
  ['Overview', LayoutGrid], ['Activity', Activity], ['Sensor Data', Radio],
];
const date = (value) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
const time = (value) => value ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(value)) : '—';
const nameOf = (id) => id === 'office' ? 'Office' : 'Data Center';
const issueOf = (incident) => incident.kind === 'low_light' ? 'Unexpected low lighting' : 'IR sensor activation';
const statusText = { queued: 'Contact queued', contacted: 'Contact recorded', accepted: 'Visit accepted', repair_reported: 'Awaiting verification', verified: 'Repair verified' };

async function api(path, token, body, signal) {
  const response = await fetch('/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The request failed.');
  return result;
}

function Brand({ dark }) {
  return <div className={'brand' + (dark ? ' on-dark' : '')}><div className="brand-mark"><Building2 size={20} /></div><span>Building<span className="brand-accent">Connect</span><small>OPERATIONS CONSOLE</small></span></div>;
}

function Badge({ tone = 'neutral', children }) {
  return <span className={'badge ' + tone}><span className="dot" />{children}</span>;
}

function Modal({ title, close, children }) {
  const ref = useRef(null);
  useEffect(() => { ref.current.showModal(); }, []);
  return <dialog ref={ref} onCancel={close} onClick={(event) => { if (event.target === ref.current) close(); }} aria-label={title}>
    <div className="modal-content">
      <div className="row spread"><h2>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={close}><X size={19} /></button></div>
      {children}
    </div>
  </dialog>;
}

function SignIn({ client }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      const { error } = await client.auth.signInWithPassword({ email: form.get('email'), password: form.get('password') });
      if (error) setError(error.message);
    } catch { setError('Could not reach the sign-in service. Try again.'); }
    finally { setBusy(false); }
  }
  return <div className="signin-card"><h1>Owner sign-in</h1><p>Sign in to monitor buildings and manage maintenance.</p>
    <form onSubmit={submit}><label>Email<input name="email" type="email" autoComplete="username" required /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="button primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form></div>;
}

function Metric({ label, value, detail, icon: Icon, tone }) {
  return <div className="card metric"><div className="row spread"><span>{label}</span><span className={'tile-icon ' + tone}><Icon size={17} /></span></div>
    <strong>{value}</strong><small>{detail}</small></div>;
}

function BuildingCard({ building, incident, onView }) {
  const office = building.id === 'office';
  const Icon = office ? Building2 : Server;
  const sensor = office ? building.reading?.sensors.light : building.reading?.sensors.flame_ir;
  const fresh = building.connection === 'fresh';
  const reading = !sensor ? '—' : office ? sensor.raw.toLocaleString() : sensor.ir_alert ? 'Active' : 'Clear';
  const health = fresh ? incident ? ['amber', 'Needs attention'] : ['green', 'No open issues'] :
    ['neutral', building.connection === 'stale' ? 'Data stale' : 'Awaiting data'];
  return <article className="card building-card">
    <div className="row spread"><div className="row"><span className={'tile-icon site-icon ' + (office ? 'blue' : 'purple')}><Icon size={22} /></span>
      <div><h3>{building.name}</h3><small>{office ? 'Lighting monitoring' : 'IR monitoring'}</small></div></div><Badge tone={health[0]}>{health[1]}</Badge></div>
    <div className="building-reading"><span>{office ? 'Ambient light' : 'IR sensor signal'}</span><div><strong>{reading}</strong>
      {office && sensor && <small> ADC counts</small>}</div>
      <small>{building.captured_at ? `${fresh ? 'Last sample' : 'Last known sample'} · ${time(building.captured_at)}` : 'Waiting for first sample'}</small>
    </div>
    <button className="text-button" onClick={onView}>View sensor data <ArrowRight size={15} /></button>
  </article>;
}

function IncidentCard({ incident, demo, decide, work, busy }) {
  const evidence = incident.evidence;
  const light = incident.kind === 'low_light';
  const [note, setNote] = useState('');
  const isPending = incident.approval === 'pending';
  const action = { queued: 'contact', contacted: 'accept', accepted: 'report' }[incident.work_status];
  const actionLabel = { contact: demo ? 'Simulate technician contact' : 'Record technician contact', accept: demo ? 'Simulate acceptance' : 'Record acceptance', report: 'Record repair findings' };
  const approval = isPending ? ['amber', 'Approval needed'] : incident.approval === 'approved' ? ['green', 'Visit approved'] :
    ['neutral', incident.approval === 'declined' ? 'Visit declined' : 'Request expired'];
  return <article className="card incident-card">
    <div className="row spread incident-top"><div className="row"><span className={'tile-icon ' + (incident.status === 'resolved' ? 'green' : 'amber')}>
      {incident.status === 'resolved' ? <Check size={20} /> : <AlertTriangle size={19} />}</span><div>
        <div className="eyebrow">{nameOf(incident.building_id)} <span>·</span> {incident.source === 'simulated' ? 'SIMULATED INCIDENT' : 'HARDWARE INCIDENT'}</div>
        <h3>{issueOf(incident)}</h3>
      </div></div><Badge tone={approval[0]}>{approval[1]}</Badge></div>
    <p>{light ? `Observed ${evidence.raw} ADC counts with lighting expected on. The lighting circuit needs inspection to confirm the cause.` :
      'The IR input registered an activation. An inspection can help determine what triggered the signal.'}</p>
    <div className="recommendation"><ClipboardCheck size={17} /><div><strong>Recommended next step</strong><p>{incident.recommendation}</p></div></div>
    <div className="incident-actions">
      {isPending && <div className="row"><button className="button primary" disabled={busy} onClick={() => decide(incident, 'approved')}>Review request <ArrowRight size={15} /></button>
        <button className="button secondary" disabled={busy} onClick={() => decide(incident, 'declined')}>Decline</button></div>}
      {incident.work_status && <div className="service">
        <div className="row"><Wrench size={16} /><strong>{statusText[incident.work_status]}</strong></div>
        {incident.findings && <p>{incident.findings}</p>}
        {incident.verification && <small>{incident.verification === 'sensor' ? 'Sensor verification' : 'Manual verification'} · {incident.verification_notes}</small>}
        {action === 'report' && <label>Repair findings<textarea value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} placeholder="Describe the inspection and what was repaired." /></label>}
        {action && <button className="button secondary" disabled={busy || (action === 'report' && !note.trim())}
          onClick={async () => { if (await work(incident, { action, notes: note })) setNote(''); }}>{actionLabel[action]}</button>}
        {incident.work_status === 'repair_reported' && <>
          <label>Manual verification notes<textarea value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} placeholder="Describe what you checked and observed." /></label>
          <div className="row wrap">
            {light && <button className="button primary" disabled={busy} onClick={() => work(incident, { action: 'verify', method: 'sensor' })}>Verify with readings</button>}
            <button className="button secondary" disabled={busy || !note.trim()} onClick={() => work(incident, { action: 'verify', method: 'manual', notes: note })}>Record manual verification</button>
          </div>
        </>}
      </div>}
      {incident.approval === 'declined' && <small>The issue remains open. The owner declined the visit.</small>}
      <small className="opened"><Clock3 size={14} /> {date(incident.opened_at)}</small>
    </div>
  </article>;
}

function EventList({ events, compact = false }) {
  if (!events.length) return <div className="empty">No activity matches this view.</div>;
  return <ol className="events">{events.map((event) => {
    const Icon = event.kind === 'detected' ? AlertTriangle : ['verify', 'approved', 'accept'].includes(event.kind) ? Check : CircleDot;
    return <li key={event.id}><span className={'event-icon ' + (event.kind === 'detected' ? 'amber' : 'blue')}><Icon size={15} /></span>
      <div><strong>{event.message}</strong><small>{nameOf(event.building_id)} · {compact ? time(event.created_at) : date(event.created_at)}</small></div></li>;
  })}</ol>;
}

function ActivityView({ events }) {
  const [building, setBuilding] = useState('all');
  return <section className="card section-card"><div className="row spread wrap"><div><h2>Activity timeline</h2><p>Incident, approval, and repair milestones.</p></div>
    <label className="inline-label">Building <select value={building} onChange={(event) => setBuilding(event.target.value)}>
      <option value="all">All buildings</option><option value="office">Office</option><option value="data_center">Data Center</option>
    </select></label></div>
    <EventList events={events.filter((event) => building === 'all' || event.building_id === building)} />
  </section>;
}

function ReadingsChart({ samples, office }) {
  if (!samples.length) return <div className="empty">No readings in the last ten minutes.</div>;
  const oldest = new Date(samples[0].captured_at).getTime();
  const duration = Math.max(1, new Date(samples.at(-1).captured_at).getTime() - oldest);
  const points = samples.map(({ captured_at, sensors }) => {
    const value = office ? sensors.light.raw / sensors.light.adc_max : Number(sensors.flame_ir.ir_alert || sensors.flame_ir.alert_seen_since_last_report);
    return `${8 + (new Date(captured_at).getTime() - oldest) / duration * 584},${140 - value * 125}`;
  });
  return <div className="chart"><svg viewBox="0 0 600 150" role="img" aria-label={office ? 'Relative ambient light history' : 'IR activation history'} preserveAspectRatio="none">
    {[15, 46, 78, 109, 140].map((y) => <line key={y} x1="8" x2="592" y1={y} y2={y} stroke="#e4eaf1" strokeDasharray="4 4" />)}
    {points.length === 1 ? <circle cx="8" cy={points[0].split(',')[1]} r="4" fill="#2563eb" /> :
      <polyline points={points.join(' ')} fill="none" stroke="#2563eb" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />}
    </svg><div className="row spread"><small>{time(samples[0].captured_at)}</small><small>{time(samples.at(-1).captured_at)}</small></div></div>;
}

function SensorsView({ buildings, incidents, selected, setSelected, token, commands, run, busy }) {
  const [history, setHistory] = useState({ id: null, samples: [], error: '' });
  const building = buildings.find((item) => item.id === selected) ?? buildings[0];
  const buildingId = building.id;
  useEffect(() => {
    const controller = new AbortController();
    let timer;
    async function load() {
      try {
        const samples = await api('/buildings/' + buildingId + '/readings', token, undefined, controller.signal);
        if (!controller.signal.aborted) setHistory({ id: buildingId, samples, error: '' });
      } catch (error) {
        if (!controller.signal.aborted) setHistory((previous) => ({
          id: buildingId, samples: previous.id === buildingId ? previous.samples : [], error: error.message,
        }));
      }
      if (!controller.signal.aborted) timer = setTimeout(load, 2500);
    }
    load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [buildingId, token]);
  const office = building.id === 'office';
  const samples = history.id === building.id ? history.samples : [];
  const outputs = [['led_1', 'LED 1'], ['led_2', 'LED 2'], ['led_3', 'LED 3'], ['fan', 'Fan representation']];
  return <>
    <div className="segmented" aria-label="Choose building">{buildings.map((item) => <button key={item.id} aria-pressed={building.id === item.id}
      className={building.id === item.id ? 'selected' : ''} onClick={() => setSelected(item.id)}>{item.name}</button>)}</div>
    <div className="building-grid">
      <BuildingCard building={building} incident={incidents.some((item) => item.building_id === building.id)}
        onView={() => document.querySelector('#history').scrollIntoView({ behavior: 'smooth' })} />
      <section className="card section-card"><h2>Controller outputs</h2><p>Commands and controller-reported state.</p>
        <div className="outputs">{outputs.map(([key, title], index) => {
          const reported = building.reading && (key === 'fan' ? building.reading.commanded.fan === 'running' : building.reading.commanded.leds[index]);
          const command = commands.find((item) => item.building_id === building.id && item.output === key);
          const target = command?.status === 'pending' ? command.enabled : reported;
          return <div key={key} className="row spread"><div><strong>{title}</strong><small>{reported == null ? 'No reported state' :
            `Reported ${reported ? 'on' : 'off'}${building.connection === 'stale' ? ' (stale)' : ''}`}{command ? ` · ${command.status}` : ''}</small></div>
            <button className="button secondary small" aria-label={`Set ${title} ${target ? 'off' : 'on'}`} disabled={busy || building.connection !== 'fresh'}
              onClick={() => run('/hardware/commands', { building_id: building.id, output: key, enabled: !target })}>{target ? 'Turn off' : 'Turn on'}</button></div>;
        })}</div>
      </section>
    </div>
    <section id="history" className="card section-card"><h2>{office ? 'Ambient light history' : 'IR activation history'}</h2>
      <p>Recent {building.source === 'simulated' ? 'simulated ' : ''}samples · {office ? 'relative to ADC range' : 'clear or active signal'}</p>
      {history.id === building.id && history.error && <p className="error" role="alert">{history.error}</p>}
      <ReadingsChart samples={samples} office={office} />
      {!!samples.length && <table><thead><tr><th scope="col">Captured</th><th scope="col">Reading</th><th scope="col">Source</th></tr></thead><tbody>
        {samples.slice(-6).reverse().map((sample, index) => <tr key={sample.captured_at + index}><td>{time(sample.captured_at)}</td>
          <td>{office ? `${sample.sensors.light.raw} ADC counts` : sample.sensors.flame_ir.ir_alert ? 'Active' : sample.sensors.flame_ir.alert_seen_since_last_report ? 'Brief activation' : 'Clear'}</td>
          <td>{sample.source === 'simulated' ? 'Simulated' : 'Hardware'}</td></tr>)}
      </tbody></table>}
    </section>
  </>;
}

function DemoControls({ close, run, busy, error }) {
  const scenarios = [
    ['office-dark', 'Simulate low light'], ['office-normal', 'Restore office lighting'],
    ['ir-alert', 'Trigger IR signal'], ['ir-clear', 'Clear IR signal'],
    ['pause', 'Pause controller reports'], ['resume', 'Resume controller reports'],
  ];
  return <Modal title="Demo controls" close={close}><p>Use simulated readings to test incidents, recovery, and controller connectivity.</p>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="scenario-grid">{scenarios.map(([scenario, label]) =>
      <button key={scenario} className="button secondary" disabled={busy} onClick={async () => { if (await run('/demo/scenario', { scenario })) close(); }}>{label}</button>)}</div>
  </Modal>;
}

function useEngine(options) {
  const canvasRef = useRef(null);
  const labelsRef = useRef(null);
  const engine = useRef(null);
  const latest = useRef(options);
  latest.current = options;
  const [status, setStatus] = useState('loading');
  useEffect(() => {
    let cancelled = false;
    let instance;
    import('./scene.js').then(({ createScene }) => {
      if (cancelled) return;
      try {
        instance = createScene(canvasRef.current, labelsRef.current, {
          interactive: latest.current.interactive,
          onSelect: (key) => latest.current.onSelect?.(key),
          onEnter: (id) => latest.current.onEnter?.(id),
        });
        engine.current = instance;
        setStatus('ready');
      } catch { setStatus('failed'); }
    }).catch(() => { if (!cancelled) setStatus('failed'); });
    return () => { cancelled = true; instance?.dispose(); engine.current = null; };
  }, []);
  return { canvasRef, labelsRef, engine, status };
}

function Landing({ client, demo, onEnter }) {
  const [form, setForm] = useState(false);
  const { canvasRef, labelsRef } = useEngine({ interactive: false });
  return <div className="landing">
    <canvas ref={canvasRef} className="world-canvas" aria-hidden="true" /><div ref={labelsRef} className="hotspots" />
    <div className="landing-shade" />
    <div className="landing-content"><Brand dark />
      <div className="landing-copy">
        <div className="eyebrow">OFFICE · DATA CENTER</div>
        <h1>Walk through your buildings.</h1>
        <p>Monitor conditions, review incidents, and approve technician visits for the office and the data center.</p>
        {form ? <div className="signin-card glass"><SignIn client={client} /><button className="text-button" onClick={() => setForm(false)}>Back</button></div> :
          <button className="button primary large" onClick={() => (demo ? onEnter() : setForm(true))}>Sign in <ArrowRight size={17} /></button>}
      </div>
    </div>
  </div>;
}

function SettingsMenu({ view, setView, client, demo, email, openControls }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (event) => { if (!ref.current?.contains(event.target)) setOpen(false); };
    const key = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  return <div className="settings" ref={ref}>
    <button className="icon-button refresh" aria-label="Settings" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(!open)}><Settings size={17} /></button>
    {open && <div className="settings-menu" role="group" aria-label="Settings">
      <div className="nav-label">VIEW</div>
      {[['3d', '3D view', Box], ['normal', 'Normal', LayoutGrid]].map(([id, label, Icon]) =>
        <button key={id} className={view === id ? 'selected' : ''} aria-pressed={view === id} onClick={() => { setView(id); setOpen(false); }}><Icon size={16} />{label}{view === id && <Check size={15} className="nav-arrow" />}</button>)}
      {(demo || client) && <div className="settings-sep" />}
      {demo && <button onClick={() => { setOpen(false); openControls(); }}><Settings2 size={16} />Demo controls</button>}
      {client && <button onClick={() => client.auth.signOut()}><LogOut size={16} />Sign out{email && <small>{email}</small>}</button>}
    </div>}
  </div>;
}

const outputList = [['led_1', 'LED 1'], ['led_2', 'LED 2'], ['led_3', 'LED 3'], ['fan', 'Fan representation']];
function sceneState(building, commands, hasIncident) {
  const reading = building.reading;
  const target = (key, index) => {
    const reported = reading ? (key === 'fan' ? reading.commanded.fan === 'running' : !!reading.commanded.leds[index]) : false;
    const command = commands.find((item) => item.building_id === building.id && item.output === key);
    return command?.status === 'pending' ? !!command.enabled : reported;
  };
  const light = reading?.sensors?.light;
  return {
    leds: [0, 1, 2].map((index) => target('led_' + (index + 1), index)), fan: target('fan', 3),
    alert: !!reading?.sensors?.flame_ir?.ir_alert, light: light ? light.raw / light.adc_max : 0.5,
    status: building.connection !== 'fresh' ? 'offline' : hasIncident ? 'alert' : 'ok',
  };
}

function SensorHistory({ buildingId, token, office }) {
  const [history, setHistory] = useState({ id: null, samples: [], error: '' });
  useEffect(() => {
    const controller = new AbortController();
    let timer;
    async function load() {
      try {
        const samples = await api('/buildings/' + buildingId + '/readings', token, undefined, controller.signal);
        if (!controller.signal.aborted) setHistory({ id: buildingId, samples, error: '' });
      } catch (error) {
        if (!controller.signal.aborted) setHistory((previous) => ({ id: buildingId, samples: previous.id === buildingId ? previous.samples : [], error: error.message }));
      }
      if (!controller.signal.aborted) timer = setTimeout(load, 2500);
    }
    load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [buildingId, token]);
  return <>{history.error && <p className="error" role="alert">{history.error}</p>}
    <ReadingsChart samples={history.id === buildingId ? history.samples : []} office={office} /></>;
}

function World({ data, demo, busy, token, run, status, notices, settings, decide, work }) {
  const [site, setSite] = useState(null);
  const [sel, setSel] = useState(null);
  const { canvasRef, labelsRef, engine, status: gl } = useEngine({ onSelect: setSel, onEnter: (id) => { setSite(id); setSel(null); } });
  const buildings = data?.buildings ?? [];
  const incidents = data?.incidents ?? [];
  const open = incidents.filter((incident) => incident.status !== 'resolved');
  const pending = open.filter((incident) => incident.approval === 'pending');
  useEffect(() => {
    if (gl !== 'ready' || !data) return;
    engine.current.setState(Object.fromEntries(data.buildings.map((building) =>
      [building.id, sceneState(building, data.commands, open.some((incident) => incident.building_id === building.id))])));
  }, [data, gl]); // eslint-disable-line react-hooks/exhaustive-deps
  const building = buildings.find((item) => item.id === site);
  const health = (item) => {
    const fresh = item.connection === 'fresh';
    const issue = open.some((incident) => incident.building_id === item.id);
    return fresh ? issue ? ['amber', 'Needs attention'] : ['green', 'No open issues'] : ['neutral', item.connection === 'stale' ? 'Data stale' : 'Awaiting data'];
  };
  const clearSelection = () => { setSel(null); engine.current?.select(null); };
  let focus = null;
  if (building && sel) {
    const office = building.id === 'office';
    if (sel === 'sensor') {
      const sensor = office ? building.reading?.sensors.light : building.reading?.sensors.flame_ir;
      const value = !sensor ? '—' : office ? sensor.raw.toLocaleString() + ' ADC counts' : sensor.ir_alert ? 'Active' : 'Clear';
      focus = <div className="card focus-card"><div className="row spread"><h3>{office ? 'Light sensor' : 'IR sensor'}</h3>
        <button className="icon-button" aria-label="Clear selection" onClick={clearSelection}><X size={16} /></button></div>
        <strong className="focus-value">{value}</strong>
        <small>{building.captured_at ? `${building.connection === 'fresh' ? 'Last sample' : 'Last known sample'} · ${time(building.captured_at)}` : 'Waiting for first sample'}</small>
        <SensorHistory buildingId={building.id} token={token} office={office} /></div>;
    } else {
      const index = outputList.findIndex(([key]) => key === sel);
      const title = outputList[index][1];
      const reported = building.reading && (sel === 'fan' ? building.reading.commanded.fan === 'running' : building.reading.commanded.leds[index]);
      const command = data.commands.find((item) => item.building_id === building.id && item.output === sel);
      const target = command?.status === 'pending' ? command.enabled : reported;
      focus = <div className="card focus-card"><div className="row spread"><h3>{title}</h3>
        <button className="icon-button" aria-label="Clear selection" onClick={clearSelection}><X size={16} /></button></div>
        <small>{reported == null ? 'No reported state' : `Reported ${reported ? 'on' : 'off'}${building.connection === 'stale' ? ' (stale)' : ''}`}{command ? ` · ${command.status}` : ''}</small>
        <button className="button primary" aria-label={`Set ${title} ${target ? 'off' : 'on'}`} disabled={busy || building.connection !== 'fresh'}
          onClick={() => run('/hardware/commands', { building_id: building.id, output: sel, enabled: !target })}>{target ? 'Turn off' : 'Turn on'}</button></div>;
    }
  }
  return <div className="world">
    <canvas ref={canvasRef} className="world-canvas" aria-label="Interactive 3D view of the office and data center" /><div ref={labelsRef} className="hotspots" />
    <header className="world-top"><Brand dark /><div className="row">{status}{settings}</div></header>
    <div className="world-notices">{notices}</div>
    {gl === 'failed' && <div className="card world-fallback" role="alert">3D view is not available in this browser. Open Settings and choose Normal.</div>}
    <aside className="world-panel" aria-label={building ? building.name : 'Buildings'}>
      {!data && <div className="card empty" role="status">Loading workspace…</div>}
      {data && !building && <>
        <div className="panel-head"><div className="eyebrow blue-text">BUILDINGS</div><h2>Choose a building</h2>
          <p><MousePointerClick size={14} /> Click a building in the scene, or pick one below, to go inside.</p></div>
        {buildings.map((item) => { const tone = health(item); const Icon = item.id === 'office' ? Building2 : Server;
          return <button key={item.id} className="card site-row" onClick={() => engine.current?.enter(item.id)}>
            <span className={'tile-icon site-icon ' + (item.id === 'office' ? 'blue' : 'purple')}><Icon size={22} /></span>
            <span className="site-info"><strong>{item.name}</strong><small>{item.id === 'office' ? 'Lighting monitoring' : 'IR monitoring'}</small></span>
            <Badge tone={tone[0]}>{tone[1]}</Badge></button>; })}
        <div className="card world-stats"><div><strong>{open.length}</strong><small>Open incidents</small></div><div><strong>{pending.length}</strong><small>Pending approvals</small></div></div>
      </>}
      {data && building && <>
        <button className="text-button back" onClick={() => engine.current?.exit()}><ArrowLeft size={15} /> All buildings</button>
        <div className="panel-head"><div className="row spread"><h2>{building.name}</h2><Badge tone={health(building)[0]}>{health(building)[1]}</Badge></div>
          <p><MousePointerClick size={14} /> Click the sensor, LEDs or fan in the scene. Drag to look around.</p></div>
        {focus}
        {incidents.filter((incident) => incident.building_id === building.id).map((incident) => <IncidentCard key={incident.id} incident={incident} demo={demo} busy={busy} decide={decide} work={work} />)}
        <div className="card recent"><h3>Recent activity</h3><EventList compact events={data.activity.filter((event) => event.building_id === building.id).slice(0, 4)} /></div>
      </>}
    </aside>
  </div>;
}

function Dashboard({ session, client, demo }) {
  const token = session?.access_token;
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('Overview');
  const [selected, setSelected] = useState('office');
  const [confirm, setConfirm] = useState(null);
  const [controls, setControls] = useState(false);
  const [view, setView] = useState(() => { try { return localStorage.getItem('bc-view') === 'normal' ? 'normal' : '3d'; } catch { return '3d'; } });
  const changeView = (next) => { setView(next); try { localStorage.setItem('bc-view', next); } catch { /* storage unavailable */ } };
  const version = useRef(0);
  const refresh = useCallback(async (signal) => {
    const request = ++version.current;
    try {
      const next = await api('/state', token, undefined, signal);
      if (!signal?.aborted && request === version.current) { setData(next); setLoadError(''); }
    } catch (error) {
      if (!signal?.aborted && request === version.current) setLoadError(error.message);
    }
  }, [token]);
  useEffect(() => {
    const controller = new AbortController();
    let timer;
    async function poll() {
      await refresh(controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
    }
    poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [refresh]);
  async function run(path, body) {
    setBusy(true);
    setActionError('');
    try {
      await api(path, token, body);
      await refresh();
      return true;
    } catch (error) { setActionError(error.message); return false; }
    finally { setBusy(false); }
  }
  const open = data?.incidents.filter((incident) => incident.status !== 'resolved') ?? [];
  const pending = open.filter((incident) => incident.approval === 'pending');
  const fresh = data?.buildings.filter((building) => building.connection === 'fresh').length ?? 0;
  const activeWork = open.filter((incident) => incident.work_id).length;
  const connected = fresh > 0 && !loadError;
  function viewBuilding(building) { setSelected(building); setTab('Sensor Data'); }
  const descriptions = {
    Overview: 'Monitor building conditions and manage maintenance requests.',
    Activity: 'Follow changes across your buildings and service requests.',
    'Sensor Data': 'Inspect recent readings and check controller outputs.',
  };
  const modals = <>
    {confirm && <Modal title={confirm.decision === 'approved' ? 'Approve technician visit' : 'Decline technician visit'} close={() => setConfirm(null)}>
      <p><strong>{nameOf(confirm.item.building_id)}</strong> · {issueOf(confirm.item)}</p><p>{confirm.item.recommendation}</p>
      <p>{confirm.decision === 'approved' ? 'Approval queues technician contact for this request.' : 'The issue stays open and technician contact is blocked.'}</p>
      {actionError && <p className="error" role="alert">{actionError}</p>}
      <div className="row modal-actions"><button className="button secondary" onClick={() => setConfirm(null)}>Cancel</button>
        <button className="button primary" disabled={busy} onClick={async () => {
          if (await run('/service-requests/' + confirm.item.request_id + '/decision', { version: confirm.item.version, decision: confirm.decision })) setConfirm(null);
        }}>{busy ? 'Saving…' : confirm.decision === 'approved' ? 'Approve visit' : 'Decline visit'}</button></div>
    </Modal>}
    {controls && <DemoControls close={() => setControls(false)} run={run} busy={busy} error={actionError} />}
  </>;
  const statusBadge = data && <Badge tone={connected ? 'green' : 'neutral'}>{loadError ? 'API unavailable' : connected ? 'Controller reporting' : 'Controller offline'}</Badge>;
  const notices = <>
    {loadError && <div className="notice error" role="alert">{loadError}{data ? ' Showing the last loaded view.' : ''}</div>}
    {actionError && !confirm && !controls && <div className="notice error" role="alert">{actionError}</div>}
  </>;
  const settingsMenu = <SettingsMenu view={view} setView={changeView} client={client} demo={demo} email={session?.user?.email}
    openControls={() => { setActionError(''); setControls(true); }} />;
  if (view === '3d') return <div className="world-shell">
    <World data={data} demo={demo} busy={busy} token={token} run={run} status={statusBadge} notices={notices} settings={settingsMenu}
      decide={(item, decision) => { setActionError(''); setConfirm({ item, decision }); }}
      work={(item, body) => run('/work-orders/' + item.work_id + '/progress', body)} />
    {modals}
  </div>;
  return <div className="shell">
    <aside className="sidebar"><Brand /><nav aria-label="Main navigation"><div className="nav-label">WORKSPACE</div>
      {tabs.map(([label, Icon]) => <button key={label} aria-current={tab === label ? 'page' : undefined} onClick={() => setTab(label)}>
        <Icon size={19} />{label}{tab === label && <ChevronRight size={15} className="nav-arrow" />}</button>)}
      {demo && <><div className="nav-label tools-label">TOOLS</div><button onClick={() => { setActionError(''); setControls(true); }}><Settings2 size={19} />Demo controls</button></>}
    </nav><div className="sidebar-bottom"><div className="row"><span className="avatar">{demo ? 'DO' : (session?.user?.email?.slice(0, 2) ?? 'OW').toUpperCase()}</span>
      <div className="profile"><strong>{demo ? 'Demo owner' : 'Building owner'}</strong><small>{demo ? 'Local workspace' : session?.user?.email}</small></div>
      {client && <button className="icon-button" aria-label="Sign out" onClick={() => client.auth.signOut()}><LogOut size={17} /></button>}</div></div></aside>
    <div className="workspace">
      <header className="topbar"><div className="breadcrumb">Workspace <ChevronRight size={14} /> <strong>{tab}</strong></div>
        <div className="row">{demo && <span className="mode"><FlaskConical size={14} /> Demo mode</span>}
          <button className="icon-button refresh" aria-label="Refresh dashboard" onClick={() => refresh()}><RefreshCw size={17} /></button>{settingsMenu}</div></header>
      <main>
        <div className="page-heading row spread wrap"><div><div className="eyebrow blue-text">BUILDING OPERATIONS</div>
          <h1>{tab === 'Overview' ? 'Operations overview' : tab}</h1><p>{descriptions[tab]}</p></div>
          {data && <Badge tone={connected ? 'green' : 'neutral'}>{loadError ? 'API unavailable' : connected ? 'Controller reporting' : 'Controller offline'}</Badge>}</div>
        {loadError && <div className="notice error" role="alert">{loadError}{data ? ' Showing the last loaded view.' : ''}</div>}
        {actionError && !confirm && !controls && <div className="notice error" role="alert">{actionError}</div>}
        {!data && !loadError && <div className="card empty" role="status">Loading workspace…</div>}
        {data && tab === 'Overview' && <>
          <div className="metrics">
            <Metric icon={Building2} tone="blue" label="Buildings" value={data.buildings.length} detail={`${fresh} reporting`} />
            <Metric icon={AlertTriangle} tone="amber" label="Open incidents" value={open.length} detail={open.length ? 'Under review' : 'No active issues'} />
            <Metric icon={ClipboardCheck} tone="purple" label="Pending approvals" value={pending.length} detail={pending.length ? 'Owner decision needed' : 'No decisions needed'} />
            <Metric icon={Wrench} tone="green" label="Active work orders" value={activeWork} detail={activeWork ? 'Service in progress' : 'No active service'} />
          </div>
          <section><div className="section-heading row spread"><div><h2>Building status</h2><p>Latest conditions across your buildings.</p></div>
            {demo && <span className="subtle-pill">Simulated telemetry</span>}</div>
            <div className="building-grid">{data.buildings.map((building) => <BuildingCard key={building.id}
              building={building} incident={open.some((incident) => incident.building_id === building.id)} onView={() => viewBuilding(building.id)} />)}</div>
          </section>
          <div className="workflow-grid">
            <section><div className="section-heading"><h2>Maintenance queue</h2><p>Review incidents and track service.</p></div>
              {!data.incidents.length && <div className="card empty"><CheckCircle2 size={22} />No maintenance incidents yet.</div>}
              <div className="stack">{data.incidents.map((incident) => <IncidentCard key={incident.id} incident={incident} demo={demo} busy={busy}
                decide={(item, decision) => { setActionError(''); setConfirm({ item, decision }); }}
                work={(item, body) => run('/work-orders/' + item.work_id + '/progress', body)} />)}</div>
            </section>
            <section><div className="section-heading"><h2>Recent activity</h2><p>Latest workflow events.</p></div>
              <div className="card recent"><EventList compact events={data.activity.slice(0, 5)} />
                <button className="text-button" onClick={() => setTab('Activity')}>View activity timeline <ArrowRight size={15} /></button></div>
            </section>
          </div>
        </>}
        {data && tab === 'Activity' && <ActivityView events={data.activity} />}
        {data && tab === 'Sensor Data' && <SensorsView buildings={data.buildings} incidents={open} selected={selected} setSelected={setSelected} token={token}
          commands={data.commands} run={run} busy={busy} />}
      </main>
    </div>
    {modals}
  </div>;
}

function App() {
  const [config, setConfig] = useState(null);
  const [client, setClient] = useState(null);
  const [session, setSession] = useState(undefined);
  const [error, setError] = useState('');
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let subscription;
    api('/config', null, undefined, controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      setConfig(value);
      if (!value.demo) {
        const auth = createClient(value.url, value.publishableKey);
        setClient(auth);
        subscription = auth.auth.onAuthStateChange((_event, session) => setSession(session)).data.subscription;
      }
    }).catch((error) => { if (!controller.signal.aborted) setError(error.message); });
    return () => { controller.abort(); subscription?.unsubscribe(); };
  }, []);
  if (!config || (!config.demo && session === undefined)) return <div className="signin"><div className="signin-panel">
    <Brand /><p role={error ? 'alert' : 'status'}>{error || 'Loading BuildingConnect…'}</p>
    {error && <button className="button secondary" onClick={() => location.reload()}>Try again</button>}</div></div>;
  if (!config.demo && !session) return <Landing client={client} />;
  if (config.demo && !entered) return <Landing demo onEnter={() => setEntered(true)} />;
  return <Dashboard key={session?.user?.id ?? 'demo'} demo={config.demo} client={client} session={session} />;
}

createRoot(document.getElementById('root')).render(<App />);
