import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// Pure rendering engine for the 3D view. It knows nothing about the API: React pushes
// state in with setState() and receives interaction events through the callbacks.

const SITES = {
  office: { x: -9, w: 10, d: 8, h: 4, shell: 0x6f9bff, accent: 0x7fb0ff, name: 'Office' },
  data_center: { x: 9, w: 10, d: 8, h: 4, shell: 0x8e78ff, accent: 0xb09cff, name: 'Data Center' },
};
const STATUS_COLOR = { ok: 0x35d49a, alert: 0xffb02e, offline: 0x7b8aa3 };
const SENSOR_LABEL = { office: 'Light sensor', data_center: 'Flame sensor' };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, k) => a + (b - a) * k;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1, ...extra });
const glow = (color, intensity = 0.05) => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, roughness: 0.4 });

function box(parent, w, h, d, material, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

export function createScene(canvas, labelLayer, opts = {}) {
  const interactive = opts.interactive !== false;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x0b1422);
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0b1422, 30, 75);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.enablePan = false;

  scene.add(new THREE.HemisphereLight(0xc4d6ff, 0x1a2436, 1.05));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(10, 18, 12);
  scene.add(sun);

  const ground = new THREE.Mesh(new THREE.CircleGeometry(70, 64), std(0x101b2d, { roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.31;
  scene.add(ground);
  const grid = new THREE.GridHelper(90, 90, 0x1f3350, 0x15233a);
  grid.position.y = -0.3;
  scene.add(grid);

  const buildings = {};
  const items = {};
  const labels = [];
  const pickables = [];
  const shellPick = [];
  const racks = [];
  const states = {};
  let inside = null;
  let tween = null;
  let selected = null;
  let hover = null;
  let hoverSite = null;
  let clock = 0;

  function addLabel(object, text, { scope, key = null, site = null, dy = 0.6 }) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'hotspot' + (site ? ' site' : '');
    el.textContent = text;
    el.hidden = true;
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      if (site) enter(site); else setSelected(key, true);
    });
    labelLayer.appendChild(el);
    labels.push({ el, object, dy, scope, key });
  }

  function addItem(parent, id, key, position, text, build, dy = 0.7) {
    const group = new THREE.Group();
    group.position.set(...position);
    parent.add(group);
    const item = { id, key, group, k: 0, spin: 0 };
    build(group, item);
    group.traverse((object) => {
      if (object.isMesh) { object.userData.key = key; object.userData.bid = id; pickables.push(object); }
    });
    items[id + ':' + key] = item;
    addLabel(group, text, { scope: id, key, dy });
    return item;
  }

  function lamp(group, item, { color, on, size, lightColor, cordLength }) {
    if (cordLength) {
      const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, cordLength, 6), std(0x0d1522));
      cord.position.y = cordLength / 2 + 0.2;
      group.add(cord);
      const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.4, 0.26, 24), std(0xdfe8f5));
      shade.position.y = 0.1;
      group.add(shade);
    } else {
      box(group, 0.4, 0.14, 0.14, std(0x0d1522), 0, 0, -0.04);
    }
    item.mat = glow(color, 0.05);
    item.on = on;
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(size, 24, 16), item.mat);
    bulb.position.y = cordLength ? -0.06 : 0;
    group.add(bulb);
    item.light = new THREE.PointLight(lightColor, 0, 11, 1.6);
    item.light.position.y = cordLength ? -0.35 : 0.1;
    group.add(item.light);
  }

  function fan(group, item, big) {
    const r = big ? 0.5 : 0.36;
    box(group, 0.7, 0.1, 0.7, std(0x18253a), 0, -1.2, 0);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.2, 12), std(0x2b3b55));
    post.position.y = -0.6;
    group.add(post);
    box(group, 0.4, 0.4, 0.34, std(0x22324c), 0, 0, 0);
    item.mat = glow(0x7fb0ff, 0.1);
    item.rotor = new THREE.Group();
    item.rotor.position.z = 0.22;
    for (let i = 0; i < 3; i += 1) {
      const pivot = new THREE.Group();
      pivot.rotation.z = (i * Math.PI * 2) / 3;
      box(pivot, r * 0.34, r, 0.03, std(0xd7e3f6), 0, r * 0.62, 0);
      item.rotor.add(pivot);
    }
    const hub = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), item.mat);
    item.rotor.add(hub);
    group.add(item.rotor);
    if (big) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 1.32, 0.04, 8, 36), std(0x22324c));
      ring.position.z = 0.22;
      group.add(ring);
    }
  }

  function buildOffice(inner, id, s) {
    box(inner, s.w - 0.4, 0.04, s.d - 0.4, std(0x233349, { roughness: 0.9 }), 0, 0.02, 0);
    const tiles = new THREE.GridHelper(s.w - 0.4, 10, 0x3a5176, 0x2c405d);
    tiles.position.y = 0.05;
    tiles.scale.z = (s.d - 0.4) / (s.w - 0.4);
    inner.add(tiles);
    const top = std(0xc8b08a);
    const frame = std(0x2a3446);
    const screen = new THREE.MeshStandardMaterial({ color: 0x0e1a2c, emissive: 0x2b6cff, emissiveIntensity: 0.8 });
    const seat = std(0x3b4c68);
    for (const z of [1.3, -0.7]) {
      for (const x of [-3.2, -1.1, 1.1, 3.2]) {
        const desk = new THREE.Group();
        desk.position.set(x, 0, z);
        inner.add(desk);
        box(desk, 1.5, 0.07, 0.75, top, 0, 0.74, 0);
        box(desk, 0.06, 0.74, 0.65, frame, -0.68, 0.37, 0);
        box(desk, 0.06, 0.74, 0.65, frame, 0.68, 0.37, 0);
        box(desk, 0.07, 0.25, 0.07, frame, 0, 0.9, -0.2);
        box(desk, 0.62, 0.38, 0.04, screen, 0, 1.15, -0.2);
        box(desk, 0.46, 0.07, 0.46, seat, 0, 0.45, 0.62);
        box(desk, 0.46, 0.5, 0.06, seat, 0, 0.72, 0.86);
      }
    }
    ['led_1', 'led_2', 'led_3'].forEach((key, i) => addItem(inner, id, key, [-3 + i * 3, 3.45, 0.3], 'LED ' + (i + 1),
      (group, item) => lamp(group, item, { color: 0xffe9a8, size: 0.17, lightColor: 0xffe9b0, cordLength: 0.55, on: 10 }), 0.5));
    addItem(inner, id, 'sensor', [-1.8, 1.25, -3.3], SENSOR_LABEL.office, (group, item) => {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.1, 12), std(0x2b3b55));
      pole.position.y = -0.6;
      group.add(pole);
      box(group, 0.7, 0.08, 0.7, std(0x18253a), 0, -1.2, 0);
      box(group, 0.42, 0.26, 0.42, std(0x1c2a40), 0, 0, 0);
      item.mat = glow(0x58a6ff, 0.5);
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.14, 20, 14, 0, Math.PI * 2, 0, Math.PI / 2), item.mat);
      dome.position.y = 0.13;
      group.add(dome);
    });
    addItem(inner, id, 'fan', [2.2, 1.25, -3.3], 'Fan', (group, item) => fan(group, item, false));
  }

  function buildDataCenter(inner, id, s) {
    box(inner, s.w - 0.4, 0.04, s.d - 0.4, std(0x141e2e, { roughness: 0.9 }), 0, 0.02, 0);
    const tiles = new THREE.GridHelper(s.w - 0.4, 10, 0x1f6b6b, 0x15404a);
    tiles.position.y = 0.05;
    tiles.scale.z = (s.d - 0.4) / (s.w - 0.4);
    inner.add(tiles);
    box(inner, 8.8, 0.02, 0.5, new THREE.MeshStandardMaterial({ color: 0x0f5a5a, emissive: 0x1a8f8f, emissiveIntensity: 0.6 }), 0, 0.06, 0.4);
    const body = std(0x0d1522, { metalness: 0.5, roughness: 0.4 });
    const palette = [0x2bff9e, 0x2b9bff, 0x2bff9e, 0x2bff9e, 0xffb02e];
    for (const [z, dir] of [[-0.9, 1], [1.7, -1]]) {
      for (const x of [-3.6, -1.2, 1.2, 3.6]) {
        const rack = new THREE.Group();
        rack.position.set(x, 0, z);
        inner.add(rack);
        box(rack, 0.95, 2.4, 0.95, body, 0, 1.2, 0);
        for (let row = 0; row < 10; row += 1) {
          for (const dx of [-0.2, 0.2]) {
            const material = new THREE.MeshBasicMaterial({ color: palette[(row + (dx > 0 ? 2 : 0) + Math.abs(Math.round(x))) % palette.length] });
            box(rack, 0.2, 0.045, 0.02, material, dx, 0.35 + row * 0.2, dir * 0.485);
            racks.push({ material, base: material.color.clone(), phase: Math.random() * 6, speed: 1 + Math.random() * 3 });
          }
        }
      }
    }
    box(inner, 7.2, 0.5, 0.08, std(0x0d1522), 0, 3.0, -3.78);
    ['led_1', 'led_2', 'led_3'].forEach((key, i) => addItem(inner, id, key, [-2 + i * 2, 3.0, -3.65], 'LED ' + (i + 1),
      (group, item) => lamp(group, item, { color: 0x35f2a0, size: 0.14, lightColor: 0x35f2a0, on: 5 }), 0.4));
    addItem(inner, id, 'sensor', [-3.4, 1.7, -3.65], SENSOR_LABEL.data_center, (group, item) => {
      box(group, 0.5, 0.34, 0.08, std(0x16392e), 0, 0, 0);
      item.mat = glow(0xff4545, 0.2);
      const lens = new THREE.Mesh(new THREE.SphereGeometry(0.11, 20, 14), item.mat);
      lens.position.z = 0.09;
      group.add(lens);
      item.light = new THREE.PointLight(0xff4545, 0, 8, 1.6);
      item.light.position.z = 0.4;
      group.add(item.light);
    });
    addItem(inner, id, 'fan', [3.4, 1.5, -3.3], 'Fan', (group, item) => fan(group, item, true));
  }

  function makeBuilding(id) {
    const s = SITES[id];
    const root = new THREE.Group();
    root.position.x = s.x;
    scene.add(root);
    const shell = std(s.shell, { transparent: true, opacity: 0.92, roughness: 0.35, metalness: 0.2, side: THREE.DoubleSide, emissive: s.accent, emissiveIntensity: 0 });
    const t = 0.3;
    [[s.w, s.h, t, 0, s.h / 2, s.d / 2], [s.w, s.h, t, 0, s.h / 2, -s.d / 2], [t, s.h, s.d, -s.w / 2, s.h / 2, 0], [t, s.h, s.d, s.w / 2, s.h / 2, 0]]
      .forEach(([w, h, d, x, y, z]) => { const wall = box(root, w, h, d, shell, x, y, z); wall.userData.site = id; shellPick.push(wall); });
    box(root, s.w + 1, 0.3, s.d + 1, std(0x182338), 0, -0.15, 0);
    const top = new THREE.Group();
    root.add(top);
    const roof = box(top, s.w + 0.5, 0.3, s.d + 0.5, shell, 0, s.h + 0.15, 0);
    roof.userData.site = id;
    shellPick.push(roof);
    const facade = new THREE.Group();
    root.add(facade);
    const windowMat = new THREE.MeshBasicMaterial({ color: s.accent, transparent: true, opacity: 0.55 });
    for (const x of [-3.8, -1.9, 1.9, 3.8]) {
      const pane = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.4), windowMat);
      pane.position.set(x, 2.3, s.d / 2 + 0.17);
      facade.add(pane);
    }
    box(facade, 1.4, 2.4, 0.08, std(0x0d1522), 0, 1.2, s.d / 2 + 0.17);
    if (id === 'data_center') {
      for (const x of [-2.5, 0, 2.5]) box(top, 1.4, 0.6, 1.4, std(0x1a2438), x, s.h + 0.6, 0);
    } else {
      box(top, 3, 0.4, 2, std(0x2a3a58), 2, s.h + 0.5, 0);
    }
    const beacon = new THREE.Group();
    beacon.position.set(0, s.h + 2.2, 0);
    const beaconMat = new THREE.MeshBasicMaterial({ color: STATUS_COLOR.offline });
    beacon.add(new THREE.Mesh(new THREE.SphereGeometry(0.3, 20, 14), beaconMat));
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.04, 8, 40), beaconMat);
    ring.rotation.x = Math.PI / 2;
    beacon.add(ring);
    root.add(beacon);
    addLabel(beacon, s.name, { scope: 'outside', site: id, dy: 0.9 });
    const inner = new THREE.Group();
    inner.visible = false;
    root.add(inner);
    (id === 'office' ? buildOffice : buildDataCenter)(inner, id, s);
    buildings[id] = { root, shell, top, facade, beacon, beaconMat, inner };
    states[id] = { leds: [false, false, false], fan: false, alert: false, light: 0.5, status: 'offline' };
  }
  Object.keys(SITES).forEach(makeBuilding);

  const aspect = () => {
    const w = canvas.clientWidth || 1;
    return (interactive && w > 760 ? w - 420 : w) / (canvas.clientHeight || 1);
  };
  const homePose = () => {
    const k = clamp(1.8 / aspect(), 1.1, 2.6) * (interactive ? 1 : 1.2);
    if (!interactive) return { pos: new THREE.Vector3(0, 6 * k, 29 * k), target: new THREE.Vector3(0, 1, 0) };
    return { pos: new THREE.Vector3(0, 12 * k, 23 * k), target: new THREE.Vector3(0, 1.5, 0) };
  };
  function outsideLimits() {
    controls.minDistance = 8; controls.maxDistance = 55;
    controls.minPolarAngle = 0.15; controls.maxPolarAngle = Math.PI * 0.47;
  }
  function insideLimits() {
    controls.minDistance = 0.5; controls.maxDistance = 9;
    controls.minPolarAngle = 0.2; controls.maxPolarAngle = Math.PI * 0.55;
  }
  outsideLimits();
  // Both the landing dive and the world intro meet at this pose, between the two buildings.
  const DIVE = { pos: new THREE.Vector3(0, 2.6, 10), target: new THREE.Vector3(0, 2, -6) };
  let viewX = 0;
  let viewY = 0;
  const viewGoal = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!interactive) return { x: 0, y: -h * 0.24 };
    return w > 760 ? { x: 210, y: 0 } : { x: 0, y: 0 };
  };
  const applyView = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    if (viewX || viewY) camera.setViewOffset(w, h, viewX, viewY, w, h); else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  };
  const home = homePose();
  camera.position.copy(interactive && opts.intro ? DIVE.pos : home.pos);
  controls.target.copy(interactive && opts.intro ? DIVE.target : home.target);
  if (!interactive) { controls.enabled = false; controls.autoRotate = true; controls.autoRotateSpeed = 0.7; }

  function flyTo(pos, target, duration, shells, done, fov = 45, view = null) {
    controls.enabled = false;
    tween = { t: 0, duration, p0: camera.position.clone(), t0: controls.target.clone(), p1: pos, t1: target, shells, done, fov0: camera.fov, fov1: fov, view0: { x: viewX, y: viewY }, view1: view };
  }
  const setOutsideVisuals = (id, visible) => {
    const b = buildings[id];
    b.top.visible = visible; b.facade.visible = visible;
    Object.entries(buildings).forEach(([key, other]) => { other.beacon.visible = visible && (key === id || !inside); });
  };

  function setSelected(key, notify) {
    selected = key;
    if (notify) opts.onSelect?.(key);
  }

  function enter(id) {
    if (!interactive || tween || inside) return;
    const s = SITES[id];
    const b = buildings[id];
    inside = id;
    setSelected(null, true);
    opts.onEnter?.(id);
    b.inner.visible = true;
    setOutsideVisuals(id, false);
    Object.values(buildings).forEach((other) => { other.beacon.visible = false; });
    flyTo(new THREE.Vector3(s.x + 4.4, 3.5, 3.5), new THREE.Vector3(s.x - 0.4, 1.3, -0.8), 1.7, [[b.shell, b.shell.opacity, 0.1]], () => {
      insideLimits();
      controls.enabled = true;
    }, 66);
  }

  function exit() {
    if (!inside || tween) return;
    const id = inside;
    const b = buildings[id];
    setSelected(null, true);
    opts.onEnter?.(null);
    outsideLimits();
    setOutsideVisuals(id, true);
    Object.values(buildings).forEach((other) => { other.beacon.visible = true; });
    const pose = homePose();
    flyTo(pose.pos, pose.target, 1.5, [[b.shell, b.shell.opacity, 0.92]], () => {
      b.inner.visible = false;
      inside = null;
      controls.enabled = true;
    });
    // Keep `inside` set while flying so interior labels and limits stay consistent until arrival.
  }

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function pick(event) {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const targets = inside ? pickables.filter((o) => o.userData.bid === inside) : shellPick;
    return raycaster.intersectObjects(targets, false)[0]?.object ?? null;
  }
  let down = null;
  const onDown = (event) => { down = { x: event.clientX, y: event.clientY }; };
  const onUp = (event) => {
    if (!down) return;
    const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
    down = null;
    if (moved > 5 || tween) return;
    const hit = pick(event);
    if (inside) setSelected(hit?.userData.key ?? null, true);
    else if (hit) enter(hit.userData.site);
  };
  const onMove = (event) => {
    if (tween) return;
    const hit = pick(event);
    hover = inside ? hit?.userData.key ?? null : null;
    hoverSite = inside ? null : hit?.userData.site ?? null;
    canvas.style.cursor = hit ? 'pointer' : '';
  };
  const onKey = (event) => { if (event.key === 'Escape') exit(); };
  if (interactive) {
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointermove', onMove);
    window.addEventListener('keydown', onKey);
  }

  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    if (!tween) { const goal = viewGoal(); viewX = goal.x; viewY = goal.y; }
    applyView();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();
  if (interactive && opts.intro) {
    viewX = 0; viewY = 0; applyView();
    const pose = homePose();
    flyTo(pose.pos, pose.target, 2.4, [], () => { controls.enabled = true; }, 45, viewGoal());
  }

  const tmp = new THREE.Vector3();
  const tint = new THREE.Color();
  function updateLabels() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    for (const label of labels) {
      const show = interactive && !tween && (label.scope === 'outside' ? !inside : inside === label.scope);
      if (!show) { label.el.hidden = true; continue; }
      label.object.getWorldPosition(tmp);
      tmp.y += label.dy;
      tmp.project(camera);
      if (tmp.z > 1) { label.el.hidden = true; continue; }
      label.el.hidden = false;
      label.el.style.transform = `translate(${(tmp.x * 0.5 + 0.5) * w}px, ${(-tmp.y * 0.5 + 0.5) * h}px) translate(-50%, -100%)`;
      label.el.classList.toggle('active', !!label.key && (label.key === selected || label.key === hover));
    }
  }

  let last = performance.now();
  function frame(now) {
    const wall = Math.min(0.35, (now - last) / 1000);
    const dt = Math.min(0.05, wall);
    last = now;
    clock += dt;
    if (tween) {
      tween.t += wall;
      const k = ease(Math.min(1, tween.t / tween.duration));
      camera.position.lerpVectors(tween.p0, tween.p1, k);
      controls.target.lerpVectors(tween.t0, tween.t1, k);
      camera.fov = lerp(tween.fov0, tween.fov1, k);
      if (tween.view1) { viewX = lerp(tween.view0.x, tween.view1.x, k); viewY = lerp(tween.view0.y, tween.view1.y, k); }
      applyView();
      tween.shells.forEach(([material, from, to]) => { material.opacity = lerp(from, to, k); });
      if (tween.t >= tween.duration) { const done = tween.done; tween = null; done?.(); }
    }
    if (!tween) controls.update();
    if (inside && !tween) {
      const s = SITES[inside];
      camera.position.set(clamp(camera.position.x, s.x - s.w / 2 + 0.6, s.x + s.w / 2 - 0.6), clamp(camera.position.y, 0.7, s.h - 0.3),
        clamp(camera.position.z, -s.d / 2 + 0.6, s.d / 2 - 0.6));
      controls.target.set(clamp(controls.target.x, s.x - 4, s.x + 4), clamp(controls.target.y, 0.3, 2.5), clamp(controls.target.z, -3, 3));
    }
    for (const [id, b] of Object.entries(buildings)) {
      b.shell.depthWrite = b.shell.opacity > 0.5;
      b.shell.emissiveIntensity = lerp(b.shell.emissiveIntensity, !inside && hoverSite === id ? 0.35 : 0, 0.15);
      b.beaconMat.color.setHex(STATUS_COLOR[states[id].status] ?? STATUS_COLOR.offline);
      b.beacon.position.y = SITES[id].h + 2.2 + Math.sin(clock * 2 + SITES[id].x) * 0.12;
      b.beacon.rotation.y = clock * 0.8;
    }
    for (const item of Object.values(items)) {
      const st = states[item.id];
      if (item.key.startsWith('led')) {
        item.k = lerp(item.k, st.leds[Number(item.key.slice(4)) - 1] ? 1 : 0, 0.14);
        item.mat.emissiveIntensity = 0.05 + item.k * 2.4;
        item.light.intensity = item.k * item.on;
      } else if (item.key === 'fan') {
        item.spin = lerp(item.spin, st.fan ? 7 : 0, 0.05);
        item.rotor.rotation.z -= item.spin * dt;
        item.mat.emissiveIntensity = 0.1 + (item.spin / 7) * 1.2;
      } else if (item.id === 'office') {
        item.mat.emissiveIntensity = 0.3 + st.light * 2.2;
      } else {
        const pulse = st.alert ? 0.8 + 0.6 * Math.sin(clock * 9) : 0.1;
        item.mat.emissiveIntensity = pulse * 2;
        item.light.intensity = st.alert ? pulse * 7 : 0;
      }
      item.k2 = lerp(item.k2 ?? 1, item.key === hover || item.key === selected ? 1.14 : 1, 0.2);
      if (inside === item.id) item.group.scale.setScalar(item.k2);
    }
    for (const rack of racks) {
      tint.copy(rack.base).multiplyScalar(0.35 + 0.65 * (0.5 + 0.5 * Math.sin(clock * rack.speed + rack.phase)));
      rack.material.color.copy(tint);
    }
    updateLabels();
    renderer.render(scene, camera);
  }
  renderer.setAnimationLoop(frame);

  return {
    setState(next) {
      for (const [id, value] of Object.entries(next)) if (states[id]) Object.assign(states[id], value);
    },
    select(key) { setSelected(key, false); },
    enter, exit,
    dive(done) {
      if (interactive || tween) return;
      controls.autoRotate = false;
      flyTo(DIVE.pos, DIVE.target, 1.7, [], done, 45, { x: 0, y: 0 });
    },
    dispose() {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointermove', onMove);
      window.removeEventListener('keydown', onKey);
      labels.forEach((label) => label.el.remove());
      scene.traverse((object) => {
        object.geometry?.dispose?.();
        [].concat(object.material ?? []).forEach((material) => material.dispose());
      });
      controls.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
