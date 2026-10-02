const test = require('node:test');
const assert = require('node:assert');
const { parse, normalize } = require('../parser.js');

test('add with drawer (Android test)', () => {
  const r = parse('just got in a WAC-47 lens, drawer 3');
  assert.equal(r.type, 'add'); assert.equal(r.drawer, 'Drawer 3'); assert.equal(r.name, 'WAC-47 lens'); assert.equal(r.quantity, 1);
});
test('add with quantity and bin (Android test, previously broken)', () => {
  const r = parse('add 4 of M5 bolts in bin 7');
  assert.equal(r.type, 'add'); assert.equal(r.quantity, 4); assert.equal(r.drawer, 'Bin 7'); assert.equal(r.name, 'M5 bolts');
});
test('spoken number words', () => {
  const r = parse('received two of the oil filters drawer three');
  assert.equal(r.quantity, 2); assert.equal(r.drawer, 'Drawer 3'); assert.equal(r.name, 'oil filters');
});
test('quantity suffix', () => {
  const r = parse('add safety wire x5 in drawer 2');
  assert.equal(r.quantity, 5); assert.equal(r.name, 'safety wire'); assert.equal(r.drawer, 'Drawer 2');
});
test('alphanumeric bin', () => {
  const r = parse('stock cotter pins in bin A-2');
  assert.equal(r.drawer, 'Bin A-2'); assert.equal(r.name, 'cotter pins');
});
test('add without drawer asks', () => {
  const r = parse('add torque wrench');
  assert.equal(r.type, 'add'); assert.equal(r.drawer, null); assert.equal(r.name, 'torque wrench');
});
test('find', () => {
  const r = parse('where is the WAC-47 lens?');
  assert.equal(r.type, 'find'); assert.equal(r.query, 'WAC-47 lens');
});
test("where's", () => { assert.deepEqual([parse("where's my torque wrench").type, parse("where's my torque wrench").query], ['find', 'torque wrench']); });
test('count', () => {
  const r = parse('how many WAC-47 lenses do I have');
  assert.equal(r.type, 'count'); assert.equal(r.query, 'WAC-47 lenses');
});
test('print label (Android test)', () => {
  const r = parse('print a label for the M5 bolts');
  assert.equal(r.type, 'print'); assert.equal(r.query, 'M5 bolts');
});
test('remove whole item', () => {
  const r = parse('remove the torque wrench');
  assert.equal(r.type, 'remove'); assert.equal(r.query, 'torque wrench'); assert.equal(r.quantity, null);
});
test('remove some', () => {
  const r = parse('used up 2 of the M5 bolts');
  assert.equal(r.type, 'remove'); assert.equal(r.query, 'M5 bolts'); assert.equal(r.quantity, 2);
});
test('list drawer', () => {
  const r = parse("what's in drawer 3");
  assert.equal(r.type, 'list'); assert.equal(r.drawer, 'Drawer 3');
});
test('list all', () => { const r = parse('show everything'); assert.equal(r.type, 'list'); assert.equal(r.drawer, null); });
test('bare item with drawer is add (Android test)', () => {
  const r = parse('torque wrench, drawer 12');
  assert.equal(r.type, 'add'); assert.equal(r.name, 'torque wrench'); assert.equal(r.drawer, 'Drawer 12');
});
test('gibberish is unknown', () => { assert.equal(parse('hello there').type, 'unknown'); assert.equal(parse('').type, 'unknown'); });
test('"new" verb does not eat item names starting with new-ish words', () => {
  assert.equal(parse('newton meter drawer 4').type, 'add');
  assert.equal(parse('newton meter drawer 4').name, 'newton meter');
});
test('normalize', () => { assert.equal(normalize('  WAC-47  Lens! '), 'wac 47 lens'); });
