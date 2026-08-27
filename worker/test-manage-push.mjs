// Manager-tier push tests: no framework, no network, exit non-zero on failure.
// Run: node worker/test-manage-push.mjs   (mirrors test-intake-suppression.mjs)
import { partitionRecipients, clockOutBodies } from './worker.js';

let failed = 0;
let total = 0;
const check = (name, cond) => {
  total++;
  console.log((cond ? 'PASS ' : 'FAIL ') + ' ' + name);
  if (!cond) failed++;
};

const staff = [
  { email: 'siddsaxena@gmail.com', role: 'owner' },
  { email: ' Sidd@HamptonsCoconuts.com ', role: ' OWNER ' },
  { email: 'jayden.martin1100@gmail.com', role: 'manager', market: ' NY ' },
  { email: 'miami.manager@example.com', role: 'manager', market: 'Miami' },
  { email: 'blank.manager@example.com', role: 'manager', market: '  ' },
  { email: 'veronikabonyc@gmail.com', role: 'team' },
  { email: '', role: 'owner' },
  { email: 'x@y.com', role: 'weird' },
];

let p = partitionRecipients(staff, null, ' ny ');
check('team rows are dropped', !p.owners.includes('veronikabonyc@gmail.com') && !p.managers.includes('veronikabonyc@gmail.com'));
check('unknown roles are dropped', !p.owners.includes('x@y.com') && !p.managers.includes('x@y.com'));
check('blank emails are dropped', p.owners.length === 2);
check('emails and roles are normalized', p.owners.includes('sidd@hamptonscoconuts.com'));
check('exact-market manager is included', p.managers.length === 1 && p.managers[0] === 'jayden.martin1100@gmail.com');
check('cross-market manager is excluded', !p.managers.includes('miami.manager@example.com'));
check('blank-market manager is excluded', !p.managers.includes('blank.manager@example.com'));
check('owners remain global for a Miami shift', partitionRecipients(staff, null, 'miami').owners.length === 2);
check('Miami manager receives only Miami', partitionRecipients(staff, null, ' MIAMI ').managers.join(',') === 'miami.manager@example.com');

p = partitionRecipients(staff, ' JAYDEN.MARTIN1100@GMAIL.COM ', 'ny');
check('excludeEmail matches case-insensitively', p.managers.length === 0);

p = partitionRecipients(staff, '', 'ny');
check('empty excludeEmail excludes nobody in target market', p.owners.length === 2 && p.managers.length === 1);

p = partitionRecipients(staff, '', null);
check('missing target market fails closed for every manager', p.owners.length === 2 && p.managers.length === 0);

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
console.log(`${total - failed} passed, ${failed} failed, ${total} total`);
process.exit(failed ? 1 : 0);
