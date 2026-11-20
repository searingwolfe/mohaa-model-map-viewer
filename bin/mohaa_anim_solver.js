// =============================================================================
//  mohaa_anim_solver.js  --  MOHAA skeleton pose solver for the animation editor.
//
//  A line-for-line port of the Python solver in mohaa_view.py, so the page can pose a
//  skeleton from raw .skc channels on its own while the user edits (no Python round
//  trip per drag). Parity with Python is checked by tests/anim_solver_parity.py.
//
//  Ported (mohaa_view.py name -> here):
//    quat_to_mat, mat_mul, mat_vec, v_add, _cross, _dot3, _normalize3, _transpose3, _col,
//    mat_to_quat, mat_to_localquat, quat_slerp, _hoserot_local, _avrot_local,
//    _solve_helper_world, bone_local, _solved_local, _v_* helpers, _leg_ik_chains,
//    solve_ik_legs, _world_to_local, compute_world, anim_solver_ctx, _driven_helpers,
//    and the per-frame body of solve_anim (solveFrame).
//  Any change to that Python must be mirrored here; the parity test catches drift.
//
//  rig: {bones:[{name,parentIdx,boneType,bindOffset,refIdx,solvable,
//                bendRatio,bendMax,spinRatio,avWeight,hoseType}]}  (parse_skd's bone dicts)
//  channels: {"<bone> rot":[x,y,z,w], "<bone> pos":[x,y,z,0], ...}  (one parse_skc frame)
// =============================================================================
(function (root) {
'use strict';
const sqrt = Math.sqrt, acos = Math.acos, sin = Math.sin, cos = Math.cos;

// ---- basic math (mohaa_view.py:50-95) ----------------------------------------
function quat_to_mat(q) {
  let x = q[0], y = q[1], z = q[2]; const w = q[3];
  x = -x; y = -y; z = -z;                 // MOHAA stores bone rotations as the inverse (conjugate)
  return [[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
          [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
          [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]];
}
function mat_mul(A, B) {
  const o = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    // Python: sum(A[i][k]*B[k][j] for k in range(3)) -> 0 + a + b + c, same order
    let s = 0; for (let k = 0; k < 3; k++) s += A[i][k] * B[k][j]; o[i][j] = s;
  }
  return o;
}
function mat_vec(A, v) { return [A[0][0] * v[0] + A[0][1] * v[1] + A[0][2] * v[2],
                                 A[1][0] * v[0] + A[1][1] * v[1] + A[1][2] * v[2],
                                 A[2][0] * v[0] + A[2][1] * v[1] + A[2][2] * v[2]]; }
function v_add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function _cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function _dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function _normalize3(v) {
  const l = sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l] : [1.0, 0.0, 0.0];
}
function _transpose3(R) { return [[R[0][0], R[1][0], R[2][0]], [R[0][1], R[1][1], R[2][1]], [R[0][2], R[1][2], R[2][2]]]; }
function _col(R, c) { return [R[0][c], R[1][c], R[2][c]]; }
function mat_to_quat(R) {
  const t = R[0][0] + R[1][1] + R[2][2];
  let s;
  if (t > 0.0) {
    s = sqrt(t + 1.0) * 2.0;
    return [(R[2][1] - R[1][2]) / s, (R[0][2] - R[2][0]) / s, (R[1][0] - R[0][1]) / s, 0.25 * s];
  }
  if (R[0][0] > R[1][1] && R[0][0] > R[2][2]) {
    s = sqrt(1.0 + R[0][0] - R[1][1] - R[2][2]) * 2.0;
    return [0.25 * s, (R[0][1] + R[1][0]) / s, (R[0][2] + R[2][0]) / s, (R[2][1] - R[1][2]) / s];
  }
  if (R[1][1] > R[2][2]) {
    s = sqrt(1.0 + R[1][1] - R[0][0] - R[2][2]) * 2.0;
    return [(R[0][1] + R[1][0]) / s, 0.25 * s, (R[1][2] + R[2][1]) / s, (R[0][2] - R[2][0]) / s];
  }
  s = sqrt(1.0 + R[2][2] - R[0][0] - R[1][1]) * 2.0;
  return [(R[0][2] + R[2][0]) / s, (R[1][2] + R[2][1]) / s, 0.25 * s, (R[1][0] - R[0][1]) / s];
}
function mat_to_localquat(R) { const q = mat_to_quat(R); return [-q[0], -q[1], -q[2], q[3]]; }
function quat_slerp(a, c, t) {
  let d = a[0] * c[0] + a[1] * c[1] + a[2] * c[2] + a[3] * c[3];
  if (d < 0.0) { c = [-c[0], -c[1], -c[2], -c[3]]; d = -d; }
  let r;
  if (d > 0.9995) {
    r = [0, 1, 2, 3].map(k => a[k] + t * (c[k] - a[k]));
  } else {
    const th = acos(Math.max(-1.0, Math.min(1.0, d))), st = sin(th);
    r = [0, 1, 2, 3].map(k => (sin((1 - t) * th) * a[k] + sin(t * th) * c[k]) / st);
  }
  const l = sqrt(pySum(r.map(x => x * x)));
  return l > 1e-9 ? r.map(x => x / l) : [0.0, 0.0, 0.0, 1.0];
}
function pySum(arr) { let s = 0; for (const x of arr) s += x; return s; }   // Python sum(): 0 + ... in order

// ---- helper bones (mohaa_view.py:96-206) -------------------------------------
function _hoserot_local(parent_R, target_R, bendRatio, bendMax, spinRatio) {
  const aim = _normalize3(_col(parent_R, 0)), taim = _normalize3(_col(target_R, 0));
  let rax = _cross(taim, aim);
  if (rax[0] * rax[0] + rax[1] * rax[1] + rax[2] * rax[2] < 1e-12) rax = [1.0, 0.0, 0.0];
  else rax = _normalize3(rax);
  const s = Math.max(-1.0, Math.min(1.0, _dot3(aim, taim))), ang = acos(s);
  let v = ang * bendRatio;
  if (v > bendMax) v = bendMax;
  const pt = _transpose3(parent_R);
  const rl = [pt[0][0] * rax[0] + pt[0][1] * rax[1] + pt[0][2] * rax[2],
              pt[1][0] * rax[0] + pt[1][1] * rax[1] + pt[1][2] * rax[2],
              pt[2][0] * rax[0] + pt[2][1] * rax[1] + pt[2][2] * rax[2]];
  const c = cos(v * 0.5), sn = sqrt(Math.max(0.0, 1.0 - c * c));
  let bend = [rl[0] * sn, rl[1] * sn, rl[2] * sn, c];
  if (spinRatio < 1.0) {
    const relR = mat_mul(pt, target_R);
    bend = quat_slerp(mat_to_quat(relR), bend, spinRatio);
  }
  return bend;
}
function _avrot_local(parent_R, ref1_R, ref2_R, weight) {
  const qw = quat_slerp(mat_to_quat(ref1_R), mat_to_quat(ref2_R), weight);
  return mat_to_quat(mat_mul(_transpose3(parent_R), quat_to_mat(qw)));
}
function _hm2q(R) {     // _solve_helper_world's local m2q (standard, non-conjugating)
  const tr = R[0][0] + R[1][1] + R[2][2];
  let s;
  if (tr > 0) { s = sqrt(tr + 1.0) * 2.0; return [(R[2][1] - R[1][2]) / s, (R[0][2] - R[2][0]) / s, (R[1][0] - R[0][1]) / s, 0.25 * s]; }
  if (R[0][0] > R[1][1] && R[0][0] > R[2][2]) { s = sqrt(1.0 + R[0][0] - R[1][1] - R[2][2]) * 2.0; return [0.25 * s, (R[0][1] + R[1][0]) / s, (R[0][2] + R[2][0]) / s, (R[2][1] - R[1][2]) / s]; }
  if (R[1][1] > R[2][2]) { s = sqrt(1.0 + R[1][1] - R[0][0] - R[2][2]) * 2.0; return [(R[0][1] + R[1][0]) / s, 0.25 * s, (R[1][2] + R[2][1]) / s, (R[0][2] - R[2][0]) / s]; }
  s = sqrt(1.0 + R[2][2] - R[0][0] - R[1][1]) * 2.0; return [(R[0][2] + R[2][0]) / s, (R[1][2] + R[2][1]) / s, 0.25 * s, (R[1][0] - R[0][1]) / s];
}
function _hq2m(q) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  return [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
          [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
          [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]];
}
function _hslerp(a, c, t) {
  let d = pySum([0, 1, 2, 3].map(k => a[k] * c[k]));
  if (d < 0) { c = c.map(v => -v); d = -d; }
  let r;
  if (d > 0.9995) r = [0, 1, 2, 3].map(k => a[k] + t * (c[k] - a[k]));
  else { const th = acos(d), s = sin(th); r = [0, 1, 2, 3].map(k => (sin((1 - t) * th) * a[k] + sin(t * th) * c[k]) / s); }
  const nrm = sqrt(pySum(r.map(v => v * v))) || 1.0;
  return r.map(v => v / nrm);
}
function _solve_helper_world(bones, i, wR, wT) {
  const bn = bones[i], pi = bn.parentIdx, bp = bn.bindOffset || [0.0, 0.0, 0.0];
  const Tw = v_add(wT[pi], mat_vec(wR[pi], bp));
  const refs = bn.refIdx;
  let R;
  if (bn.boneType === 6) {                       // AvRot (knee): world slerp of the two refs
    R = _hq2m(_hslerp(_hm2q(wR[refs[0]]), _hm2q(wR[refs[1]]), pick(bn.avWeight, 0.5)));
  } else {
    const lname = (bn.name || '').toLowerCase();
    if (lname.indexOf('wrist') >= 0) {           // wrist hose: aim at the forearm bone, roll from hand Y
      const _tgt = refs[0];
      const _nx = _v_norm([0, 1, 2].map(k => wT[_tgt][k] - Tw[k]));
      let _uy = [0, 1, 2].map(k => wR[pi][k][1]);
      const du = _v_dot(_uy, _nx);
      _uy = [0, 1, 2].map(k => _uy[k] - du * _nx[k]);
      if (_v_dot(_uy, _uy) < 1e-6) _uy = [0, 1, 2].map(k => wR[pi][k][2]);
      _uy = _v_norm(_uy);
      const _nz = [_nx[1] * _uy[2] - _nx[2] * _uy[1], _nx[2] * _uy[0] - _nx[0] * _uy[2], _nx[0] * _uy[1] - _nx[1] * _uy[0]];
      R = [[_nx[0], _uy[0], _nz[0]], [_nx[1], _uy[1], _nz[1]], [_nx[2], _uy[2], _nz[2]]];
    } else if (lname.indexOf('ankle') >= 0) {    // ankle hose, by the .skd's HoseRot variant
      const Rt = wR[refs[0]], ht = pick(bn.hoseType, 2);
      if (ht === 2) {                            // HOSEROTBOTH: the calf flipped 180 about its local Y
        R = [0, 1, 2].map(r => [-Rt[r][0], Rt[r][1], -Rt[r][2]]);
      } else {                                   // HOSEROT / HOSEROTPARENT: the engine's bend toward the calf
        let Rp = wR[pi];
        if (ht === 1) Rp = [0, 1, 2].map(r => [-Rp[r][0], Rp[r][1], -Rp[r][2]]);
        const q = _hoserot_local(Rp, Rt, pick(bn.bendRatio, 1.0), pick(bn.bendMax, 180.0), pick(bn.spinRatio, 1.0));
        R = mat_mul(Rp, quat_to_mat(q));
      }
    } else {
      R = _hq2m(_hm2q(wR[refs[0]]));             // hip: track the target bone's world orientation
    }
  }
  return [R, Tw];
}
function pick(v, d) { return v === undefined || v === null ? d : v; }   // Python dict.get(k, d)

// ---- local transforms (mohaa_view.py:687-735) --------------------------------
function bone_local(bn, channels) {
  let q = channels[bn.name + ' rotFK'];
  if (q === undefined || q === null) q = pick(channels[bn.name + ' rot'], [0, 0, 0, 1]);
  let p;
  if (bn.boneType === 1) {
    p = channels[bn.name + ' pos'];
    if (p === undefined || p === null) p = bn.bindOffset || [0, 0, 0];
  } else {
    p = bn.bindOffset || [0, 0, 0];
  }
  return [p.slice(0, 3), q];
}
function _solved_local(bones, i, channels, wR, wT) {
  const bn = bones[i], bt = bn.boneType;
  if ((bt === 5 || bt === 6) && bn.solvable) {
    const pi = bn.parentIdx, refs = bn.refIdx;
    let q;
    if (bt === 5) q = _hoserot_local(wR[pi], wR[refs[0]], pick(bn.bendRatio, 1.0), pick(bn.bendMax, 180.0), pick(bn.spinRatio, 1.0));
    else q = _avrot_local(wR[pi], wR[refs[0]], wR[refs[1]], pick(bn.avWeight, 0.5));
    return [(bn.bindOffset || [0, 0, 0]).slice(0, 3), q];
  }
  return bone_local(bn, channels);
}
function _v_sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function _v_dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function _v_len(a) { return sqrt(_v_dot(a, a)); }
function _v_norm(a) { const l = _v_len(a) || 1.0; return [a[0] / l, a[1] / l, a[2] / l]; }
function _v_cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function _v_scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }

// ---- leg IK (mohaa_view.py:737-816) ------------------------------------------
function _leg_ik_chains(bones) {
  const out = [];
  for (let fo = 0; fo < bones.length; fo++) {
    const bn = bones[fo];
    if (bn.boneType !== 4) continue;
    const ca = bn.parentIdx;
    if (ca < 0 || bones[ca].boneType !== 3) continue;
    const th = bones[ca].parentIdx;
    if (th < 0 || bones[th].boneType !== 2) continue;
    out.push([th, ca, fo]);
  }
  return out;
}
const I3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
function solve_ik_legs(bones, channels, wR, wT, chains) {
  const locked = new Set();
  for (const [th, ca, fo] of chains) {
    const tgt = channels[bones[fo].name + ' pos'];
    if (!tgt) continue;                          // FK-only frame: leave the FK result alone
    const upper = _v_len(bones[ca].bindOffset), lower = _v_len(bones[fo].bindOffset);
    if (upper < 1e-3 || lower < 1e-3) continue;
    const pi = bones[th].parentIdx;
    const Rp = pi >= 0 ? wR[pi] : I3;
    let H = pi >= 0 ? wT[pi].slice() : [0.0, 0.0, 0.0];
    H = v_add(H, mat_vec(Rp, bones[th].bindOffset || [0.0, 0.0, 0.0]));
    const poleParent = _v_scale(_col(Rp, 2), -1.0);
    const fq = pick(channels[bones[fo].name + ' rot'], [0.0, 0.0, 0.0, 1.0]);
    const Rfoot = quat_to_mat(fq), footZ = _col(Rfoot, 2);
    let F = [tgt[0], tgt[1], tgt[2]];
    let X = _v_sub(F, H), d = _v_len(X);
    if (d < 1e-4) continue;
    X = _v_norm(X);
    const maxreach = upper + lower - 0.001;
    if (d > maxreach) { d = maxreach; F = v_add(H, _v_scale(X, maxreach)); }
    let Yv = v_add(_v_cross(poleParent, X), _v_cross(footZ, X));
    if (_v_len(Yv) < 1e-6) Yv = [0.0, 1.0, 0.0];
    Yv = _v_norm(Yv); const Zv = _v_cross(X, Yv);
    let maxLength = (d * d + upper * upper - lower * lower) / (2.0 * d * upper);
    maxLength = Math.max(-1.0, Math.min(1.0, maxLength));
    let cosElbow = -((lower * lower + upper * upper - d * d) / (2.0 * upper * lower));
    cosElbow = Math.max(-1.0, Math.min(1.0, cosElbow));
    const sLen = -sqrt(Math.max(0.0, 1.0 - maxLength * maxLength));
    const Xt = [0, 1, 2].map(k => X[k] * maxLength - Yv[k] * sLen);
    const Yt = [0, 1, 2].map(k => X[k] * sLen + Yv[k] * maxLength);
    const R_th = [0, 1, 2].map(r => [Xt[r], Yt[r], Zv[r]]);
    const K = v_add(H, _v_scale(Xt, upper));
    const fLen = sqrt(Math.max(0.0, 1.0 - cosElbow * cosElbow));
    const Xc = [0, 1, 2].map(k => Xt[k] * cosElbow - Yt[k] * fLen);
    const Yc = [0, 1, 2].map(k => Xt[k] * fLen + Yt[k] * cosElbow);
    const R_ca = [0, 1, 2].map(r => [Xc[r], Yc[r], Zv[r]]);
    wR[th] = R_th; wT[th] = H.slice();
    wR[ca] = R_ca; wT[ca] = K.slice();
    wR[fo] = Rfoot.map(row => row.slice()); wT[fo] = F.slice();
    locked.add(th); locked.add(ca); locked.add(fo);
  }
  return locked;
}

// ---- world pose (mohaa_view.py:817-866) --------------------------------------
function _world_to_local(bones, i, wR, wT) {
  const pi = bones[i].parentIdx;
  if (pi < 0) return [wT[i].slice(), mat_to_localquat(wR[i])];
  const PR = _transpose3(wR[pi]);
  const lR = mat_mul(PR, wR[i]), lp = mat_vec(PR, _v_sub(wT[i], wT[pi]));
  return [lp, mat_to_localquat(lR)];
}
function compute_world(bones, channels, chains) {
  chains = chains || _leg_ik_chains(bones);
  const n = bones.length, wR = new Array(n).fill(null), wT = new Array(n).fill(null);
  const ikbones = new Set();
  for (const ch of chains) if (channels[bones[ch[2]].name + ' pos']) { ikbones.add(ch[0]); ikbones.add(ch[1]); ikbones.add(ch[2]); }
  let iksolved = false;
  function resolve(i) {
    if (wR[i] !== null) return;
    const bn = bones[i], pi = bn.parentIdx;
    if (pi >= 0) resolve(pi);
    if (ikbones.has(i) && !iksolved) {
      iksolved = true;
      for (const [th] of chains) { const pp = bones[th].parentIdx; if (pp >= 0) resolve(pp); }
      solve_ik_legs(bones, channels, wR, wT, chains);
      if (wR[i] !== null) return;
    }
    if ((bn.boneType === 5 || bn.boneType === 6) && bn.solvable) {
      for (const r of bn.refIdx) if (r >= 0) resolve(r);
      const rt = _solve_helper_world(bones, i, wR, wT); wR[i] = rt[0]; wT[i] = rt[1];
      return;
    }
    const pq = _solved_local(bones, i, channels, wR, wT);
    const lR = quat_to_mat(pq[1]), lT = pq[0].slice();
    if (pi < 0) { wR[i] = lR; wT[i] = lT; }
    else { wR[i] = mat_mul(wR[pi], lR); wT[i] = v_add(mat_vec(wR[pi], lT), wT[pi]); }
  }
  for (let i = 0; i < n; i++) resolve(i);
  return [wR, wT];
}

// ---- per-animation context + one solved frame (mohaa_view.py:1736-1814) ------
function solverCtx(bones) {
  const helper_idx = [];
  bones.forEach((bn, bi) => { if ((bn.boneType === 5 || bn.boneType === 6) && bn.solvable) helper_idx.push(bi); });
  return {helper_idx: helper_idx, leg_chains: _leg_ik_chains(bones)};
}
function drivenHelpers(bones, ctx, chanNames) {
  const has = n => chanNames.has(n);
  const ik_leg = new Map();
  for (const [th, ca, fo] of ctx.leg_chains) {
    const h = has(bones[fo].name + ' pos');
    ik_leg.set(th, h); ik_leg.set(ca, h); ik_leg.set(fo, h);
  }
  function driven(bi) {
    if (ik_leg.get(bi)) return true;
    const nm = bones[bi].name;
    return has(nm + ' rotFK') || has(nm + ' rot') || has(nm + ' pos');
  }
  const out = [];
  for (const hi of ctx.helper_idx) {
    const refs = (bones[hi].refIdx || []).filter(r => r >= 0);
    if (refs.length && refs.every(driven)) out.push(hi);
  }
  return out;
}
// One frame -> {boneIdx: [qx,qy,qz,qw] | [px,py,pz,qx,qy,qz,qw]}, the record worldFromPose
// takes (solve_anim's per-frame dict, unrounded). frHelpers: drivenHelpers() for the
// animation's channel set (every frame of a .skc shares one list). movement: optional
// movement-slot channels laid under the frame (the action's channels win).
function solveFrame(bones, raw, ctx, frHelpers, movement) {
  const fr = movement ? Object.assign({}, movement, raw) : raw;
  const d = {};
  for (let bi = 0; bi < bones.length; bi++) {
    const bn = bones[bi], nm = bn.name;
    if ((nm + ' rotFK') in fr || (nm + ' rot') in fr || (nm + ' pos') in fr) {
      const pq = bone_local(bn, fr), p = pq[0], q = pq[1];
      if (bn.boneType === 1 && !((nm + ' pos') in fr)) d[bi] = [q[0], q[1], q[2], q[3]];
      else d[bi] = [p[0], p[1], p[2], q[0], q[1], q[2], q[3]];
    }
  }
  const fr_ik = ctx.leg_chains.filter(ch => (bones[ch[2]].name + ' pos') in fr);
  if (frHelpers.length || fr_ik.length) {
    const w = compute_world(bones, fr, ctx.leg_chains), fwR = w[0], fwT = w[1];
    for (const bi of frHelpers) { const pq = _world_to_local(bones, bi, fwR, fwT); d[bi] = pq[0].concat(pq[1]); }
    for (const ch of fr_ik) for (const bi of ch) { const pq = _world_to_local(bones, bi, fwR, fwT); d[bi] = pq[0].concat(pq[1]); }
  }
  return d;
}
// A whole animation (parse_skc's "frames" list) -> solved frame records, like solve_anim.
function solveAnim(bones, frames, movement, ctx) {
  ctx = ctx || solverCtx(bones);
  const names = new Set();
  if (frames.length) for (const k in frames[0]) names.add(k);
  if (movement) for (const k in movement) names.add(k);
  const frHelpers = drivenHelpers(bones, ctx, names);
  return frames.map(raw => solveFrame(bones, raw, ctx, frHelpers, movement));
}

const API = {quat_to_mat, mat_to_quat, mat_to_localquat, quat_slerp, compute_world,
             solverCtx, drivenHelpers, solveFrame, solveAnim, _leg_ik_chains, _world_to_local};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else root.MohaaAnimSolver = API;
})(typeof window !== 'undefined' ? window : this);
