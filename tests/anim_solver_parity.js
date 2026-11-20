// Node half of tests/anim_solver_parity.py: re-solve every dumped clip with
// bin/mohaa_anim_solver.js and compare against Python's solve_anim output.
// Usage: node tests/anim_solver_parity.js <parity.jsonl> [tol]
'use strict';
const fs = require('fs'), path = require('path'), readline = require('readline');
const S = require(path.join(__dirname, '..', 'bin', 'mohaa_anim_solver.js'));
const file = process.argv[2], tol = parseFloat(process.argv[3] || '1e-9');

(async () => {
  const rl = readline.createInterface({input: fs.createReadStream(file), crlfDelay: Infinity});
  let bones = null, rig = '', ctx = null;
  let cases = 0, frames = 0, bad = 0, worst = 0, worstAt = '';
  const perRig = {};
  for await (const line of rl) {
    if (!line) continue;
    const j = JSON.parse(line);
    if (j.rig) { rig = j.rig; bones = j.bones; ctx = S.solverCtx(bones); perRig[rig] = perRig[rig] || {cases: 0, worst: 0}; continue; }
    const names = new Set(j.names);
    if (j.movement) for (const k in j.movement) names.add(k);
    const frH = S.drivenHelpers(bones, ctx, names);
    let caseWorst = 0, why = '';
    j.frames.forEach((raw, fi) => {
      const got = S.solveFrame(bones, raw, ctx, frH, j.movement || null), exp = j.expect[fi];
      const ek = Object.keys(exp).sort(), gk = Object.keys(got).sort();
      if (ek.join() !== gk.join()) { caseWorst = Infinity; why = `frame ${fi}: bone set differs (${ek.length} vs ${gk.length})`; return; }
      for (const k of ek) {
        const a = exp[k], b = got[k];
        if (a.length !== b.length) { caseWorst = Infinity; why = `frame ${fi} bone ${k}: ${a.length} vs ${b.length} values`; return; }
        for (let c = 0; c < a.length; c++) {
          const e = Math.abs(a[c] - b[c]);
          if (!(e <= caseWorst)) { caseWorst = e; why = `frame ${fi} bone ${k} (${bones[+k].name}) [${c}] py ${a[c]} js ${b[c]}`; }
        }
      }
      frames++;
    });
    cases++; perRig[rig].cases++;
    if (caseWorst > perRig[rig].worst) perRig[rig].worst = caseWorst;
    if (caseWorst > worst) { worst = caseWorst; worstAt = `${rig} :: ${j.case} :: ${why}`; }
    if (caseWorst > tol) { bad++; if (bad <= 15) console.log(`[DIFF ${caseWorst.toExponential(2)}] ${rig} :: ${j.case} :: ${why}`); }
  }
  for (const r in perRig) console.log(`  ${r}: ${perRig[r].cases} clips, max diff ${perRig[r].worst.toExponential(2)}`);
  console.log(`node: ${cases} cases, ${frames} frames, ${bad} over tol ${tol}; worst ${worst.toExponential(3)}`);
  if (worstAt) console.log(`  worst at ${worstAt}`);
  process.exit(bad ? 1 : 0);
})();
