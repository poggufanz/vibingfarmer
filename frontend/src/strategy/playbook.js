// frontend/src/strategy/playbook.js
// ACE counter layer — now a thin re-export of the unified rule store. Kept as a
// stable import surface for existing callers (app.jsx, reflector wiring): the
// helpful/harmful evidence and the derived [0.5,1.5] council weight live on rule
// records in ruleStore.js. See ruleStore.js / seeds.js for the living-playbook engine.
export { increment, weight, getCounters, clearPlaybook } from './ruleStore.js'
