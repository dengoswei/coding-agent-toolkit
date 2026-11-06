import test from "node:test";
import assert from "node:assert/strict";
import { withScreamControl, upgradeScreamControl } from "../../herdr-insights/scripts/toolbar.mjs";

const base = `import { View, div, image } from "gpui-kit";
export default class Tabs extends View {
  render() {
    const t = { hover: "hover" };
    const button = () => div();
    return div().child(button("tab-new", "+"));
  }
}`;

function element(type, value) {
  const node = { type, value, props: {}, children: [], events: {} };
  const el = new Proxy(node, { get(object, name) {
    if (name in object) return object[name];
    if (name === "child") return (child) => { node.children.push(child); return el; };
    if (name === "when") return (condition, apply) => condition ? apply(el) : el;
    if (name === "on_mouse_down" || name === "on_mouse_up") return (_button, handler) => { node.events[name] = handler; return el; };
    if (name === "on_hover" || name === "on_click") return (handler) => { node.events[name] = handler; return el; };
    return (...args) => { node.props[name] = args.length === 1 ? args[0] : args; return el; };
  } });
  return el;
}
function find(root, id) {
  if (root.props.id === id) return root;
  for (const child of root.children) { const result = find(child, id); if (result) return result; }
  return null;
}

test("pressing anywhere on the stable hit target squeezes the whole gold-backed control and changes its face", () => {
  const code = withScreamControl(base).replace(/^import .*;\n/gm, "").replace("export default class", "class");
  const Tabs = new Function("View", "div", "image", `${code}\nreturn Tabs;`)(class {}, () => element("div"), (file) => element("image", file));
  const tabs = new Tabs();
  let root = tabs.render();
  const hit = find(root, "insights-scream-chicken");
  assert.equal(hit.props.w, 34); assert.equal(hit.props.h, 30);
  assert.equal(find(root, "scream-chicken-surface").props.bg, "#00000000");
  assert.equal(find(root, "scream-chicken-image").value, "mods/insights/scream-chicken.svg");
  const cx = { stop_propagation() {}, notify() {} };
  hit.events.on_mouse_down({}, cx);
  root = tabs.render();
  assert.equal(find(root, "insights-scream-chicken").props.w, 34, "visual squeezing must not move the hit target");
  assert.equal(find(root, "insights-scream-chicken").props.h, 30);
  assert.equal(find(root, "scream-chicken-surface").props.h, 26);
  assert.equal(find(root, "scream-chicken-surface").props.bg, "#704900");
  assert.equal(find(root, "scream-chicken-surface").props.border_color, "#ffd54f");
  assert.equal(find(root, "scream-chicken-image").value, "mods/insights/scream-chicken-pressed.svg");
  find(root, "insights-scream-chicken").events.on_mouse_up({}, cx);
  assert.equal(find(tabs.render(), "scream-chicken-surface").props.bg, "#00000000");
  hit.events.on_mouse_down({}, cx);
  find(tabs.render(), "insights-scream-chicken").events.on_hover(false, cx);
  assert.equal(tabs.screamPressed, false, "dragging out cancels the visual press");
});

test("skin upgrade is idempotent and fails closed for an unrecognized personal control", () => {
  const current = withScreamControl(base);
  assert.equal(upgradeScreamControl(current), current);
  assert.throws(() => upgradeScreamControl(current.replace('h(this.screamPressed ? 26 : 30)', 'h(23)')), /edited locally/);
});
