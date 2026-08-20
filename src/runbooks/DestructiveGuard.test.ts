import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect, _patternLabels } from './DestructiveGuard.js';

test('catches rm -rf in common forms', () => {
  assert.ok(inspect('rm -rf /var/log/foo'));
  assert.ok(inspect('rm -fr /tmp/stuff'));
  assert.ok(inspect('sudo rm -rf ./build')); // sudo prefix
  assert.ok(inspect('cd /tmp && rm -rf cache'));
});

test('catches mkfs, fdisk, dd if=, shutdown, reboot', () => {
  assert.ok(inspect('mkfs.ext4 /dev/sdb1'));
  assert.ok(inspect('fdisk /dev/sda'));
  assert.ok(inspect('dd if=/dev/zero of=/dev/sdb'));
  assert.ok(inspect('shutdown -h now'));
  assert.ok(inspect('reboot'));
});

test('catches systemctl disable, iptables -F, ufw disable', () => {
  assert.ok(inspect('systemctl disable nginx'));
  assert.ok(inspect('sudo iptables -F'));
  assert.ok(inspect('ufw disable'));
});

test('catches writes to /etc and /var via redirection or tee', () => {
  assert.ok(inspect('echo "evil" > /etc/passwd'));
  assert.ok(inspect('echo "log" >> /var/log/auth.log'));
  assert.ok(inspect('echo "x" | tee /etc/hostname'));
});

test('catches rm anywhere under /etc or /var even without -rf', () => {
  assert.ok(inspect('rm /etc/somefile'));
  assert.ok(inspect('rm -f /var/lib/whatever'));
});

test('allows benign commands', () => {
  assert.equal(inspect(''), null);
  assert.equal(inspect('ls -la /var/log'), null, 'read-only access to /var must not trip');
  assert.equal(inspect('cat /etc/hostname'), null, 'read-only access to /etc must not trip');
  assert.equal(inspect('docker ps'), null);
  assert.equal(inspect('systemctl status nginx'), null);
  assert.equal(inspect('ps aux --sort=-%cpu | head'), null);
  assert.equal(inspect('df -h'), null);
  assert.equal(inspect('journalctl --no-pager -n 20'), null);
});

test('match descriptions surface actionable wording for the approver', () => {
  const m = inspect('rm -rf /opt/build');
  assert.ok(m);
  assert.equal(m!.pattern, 'rm -rf');
  assert.match(m!.description, /recursive/i);
});

test('pattern labels are stable for audit log expectations', () => {
  const labels = _patternLabels();
  assert.ok(labels.includes('rm -rf'));
  assert.ok(labels.includes('mkfs'));
  assert.ok(labels.includes('reboot'));
});
