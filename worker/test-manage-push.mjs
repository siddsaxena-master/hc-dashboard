// Manager-tier push tests: no framework, no network, exit non-zero on failure.
// Run: node worker/test-manage-push.mjs   (mirrors test-intake-suppression.mjs)
import { partitionRecipients, clockOutBodies } from './worker.js';

let failed = 0;
const check = (name, cond) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + ' ' + name);
  if (!cond) failed++;
};

const staff = [
  { email: 'siddsaxena@gmail.com', role: 'owner' },
  { email: 'Sidd@HamptonsCoconuts.com', role: 'owner' },
  { email: 'jayden.martin1100@gmail.com', role: 'manager' },
  { email: 'veronikabonyc@gmail.com', role: 'team' },
  { email: '', role: 'owner' },
  { email: 'x@y.com', role: 'weird' },
];

let p = partitionRecipients(staff, null);
check('team rows are dropped', !p.owners.includes('veronikabonyc@gmail.com') && !p.managers.includes('veronikabonyc@gmail.com'));
check('unknown roles are dropped', !p.owners.includes('x@y.com') && !p.managers.includes('x@y.com'));
check('blank emails are dropped', p.owners.length === 2);
check('emails are lowercased', p.owners.includes('sidd@hamptonscoconuts.com'));
check('managers partition separately', p.managers.length === 1 && p.managers[0] === 'jayden.martin1100@gmail.com');

p = partitionRecipients(staff, 'JAYDEN.MARTIN1100@GMAIL.COM');
check('excludeEmail matches case-insensitively', p.managers.length === 0);

p = partitionRecipients(staff, '');
check('empty excludeEmail excludes nobody', p.owners.length === 2 && p.managers.length === 1);

let b = clockOutBodies(252, 1900, 45);
check('owner body carries dollars', b.owner === '4:12 on shift - $79.80');
check('manager body carries boxes, never dollars', b.manager === '4:12 on shift - 5 boxes' && !b.manager.includes('$'));

b = clockOutBodies(252, null, 45);
check('null rate: owner body is duration only', b.owner === '4:12 on shift');

b = clockOutBodies(90, 1800, 0);
check('zero boxes: manager body is duration only', b.manager === '1:30 on shift');

b = clockOutBodies(60, 1800, 30);
check('fractional boxes render with one decimal', b.manager === '1:00 on shift - 3.3 boxes');

console.log('');
console.log(failed === 0 ? `${12 - failed} passed, 0 failed, 12 total` : `${12 - failed} passed, ${failed} failed, 12 total`);
process.exit(failed ? 1 : 0);
