import fs from 'node:fs';
import net from 'node:net';

// Port forwarding to a USB-connected iPhone through Apple's usbmuxd, the same mechanism
// iproxy (libimobiledevice) and Appium use. Built in, so no extra tool has to be installed.
//
// Wire format: a 16 byte little-endian header (length incl. header, version 1, type 8 = plist, tag)
// followed by an XML property list.

export const USBMUXD_SOCKET = process.env.SNAPCRAWL_USBMUXD || '/var/run/usbmuxd';

/* ---------- minimal XML plist ---------- */

const xesc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function plistValue(v) {
  if (typeof v === 'string') return `<string>${xesc(v)}</string>`;
  if (typeof v === 'boolean') return v ? '<true/>' : '<false/>';
  if (Number.isInteger(v)) return `<integer>${v}</integer>`;
  if (typeof v === 'number') return `<real>${v}</real>`;
  if (Buffer.isBuffer(v)) return `<data>${v.toString('base64')}</data>`;
  if (Array.isArray(v)) return `<array>${v.map(plistValue).join('')}</array>`;
  return `<dict>${Object.entries(v).map(([k, x]) => `<key>${xesc(k)}</key>${plistValue(x)}`).join('')}</dict>`;
}

export const buildPlist = (obj) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${plistValue(obj)}</plist>\n`;

export function parsePlist(xml) {
  const tokens = [...String(xml).slice(String(xml).indexOf('<plist')).matchAll(/<(\/?)([a-z]+)[^>]*?(\/?)>|([^<]+)/g)];
  let i = 0;
  const tag = () => {
    let t;
    do t = tokens[i++];
    while (t && t[4] !== undefined);
    if (!t) throw new Error('truncated plist');
    return t;
  };
  const text = () => {
    let s = '';
    if (tokens[i]?.[4] !== undefined) s = tokens[i++][4];
    i++; // closing tag
    return unesc(s);
  };
  const value = (t) => {
    const [, , name, self] = t;
    if (name === 'true') return true;
    if (name === 'false') return false;
    if (name === 'dict') {
      const o = {};
      if (self) return o;
      for (let k = tag(); k[1] !== '/'; k = tag()) o[text()] = value(tag());
      return o;
    }
    if (name === 'array') {
      const a = [];
      if (self) return a;
      for (let k = tag(); k[1] !== '/'; k = tag()) a.push(value(k));
      return a;
    }
    if (self) return name === 'string' ? '' : null;
    const s = text();
    if (name === 'integer' || name === 'real') return Number(s);
    if (name === 'data') return Buffer.from(s.replace(/\s+/g, ''), 'base64');
    return s;
  };
  let t = tag();
  if (t[2] === 'plist') t = tag();
  return value(t);
}

/* ---------- usbmuxd client ---------- */

function frame(obj, tagNo = 1) {
  const body = Buffer.from(buildPlist(obj));
  const h = Buffer.alloc(16);
  h.writeUInt32LE(16 + body.length, 0);
  h.writeUInt32LE(1, 4);
  h.writeUInt32LE(8, 8);
  h.writeUInt32LE(tagNo, 12);
  return Buffer.concat([h, body]);
}

const BASE = { ClientVersionString: 'snapcrawl', ProgName: 'snapcrawl', kLibUSBMuxVersion: 3 };

// Send one message, read one reply. The socket stays open (paused) for Connect.
function request(msg, { socketPath = USBMUXD_SOCKET, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => fail(new Error('usbmuxd did not answer')), timeout);
    const fail = (e) => {
      clearTimeout(timer);
      sock.destroy();
      reject(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? new Error(`usbmuxd not reachable at ${socketPath} (${e.code}) · is this a Mac with Xcode?`) : e);
    };
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 16) return;
      const len = buf.readUInt32LE(0);
      if (buf.length < len) return;
      clearTimeout(timer);
      sock.pause();
      sock.removeListener('data', onData);
      sock.removeListener('error', fail);
      try {
        resolve({ reply: parsePlist(buf.subarray(16, len).toString('utf8')), sock, rest: buf.subarray(len) });
      } catch (e) {
        fail(e);
      }
    };
    sock.on('data', onData);
    sock.on('error', fail);
    sock.on('connect', () => sock.write(frame({ ...BASE, ...msg })));
  });
}

const sameUdid = (a, b) => String(a).replace(/-/g, '').toUpperCase() === String(b).replace(/-/g, '').toUpperCase();

export async function listUsbDevices(opts) {
  const { reply, sock } = await request({ MessageType: 'ListDevices' }, opts);
  sock.destroy();
  return (reply.DeviceList || []).map((d) => ({ id: d.DeviceID, udid: d.Properties?.SerialNumber || '', type: d.Properties?.ConnectionType || '' }));
}

const CONNECT_ERRORS = { 1: 'bad command', 2: 'device not connected', 3: 'nothing listening on that port of the device', 5: 'bad usbmux version' };

// Open a TCP connection to `port` on the device; resolves to a paused socket.
export async function connectDevice(udid, port, opts) {
  const devices = await listUsbDevices(opts);
  const matches = devices.filter((d) => !udid || sameUdid(d.udid, udid));
  const dev = matches.find((d) => d.type === 'USB') || matches[0];
  if (!dev) throw new Error(`device ${udid || ''} is not connected over USB (usbmuxd sees ${devices.length} device${devices.length === 1 ? '' : 's'})`);
  const { reply, sock, rest } = await request({ MessageType: 'Connect', DeviceID: dev.id, PortNumber: ((port & 0xff) << 8) | (port >> 8) }, opts);
  if (reply.MessageType !== 'Result' || reply.Number !== 0) {
    sock.destroy();
    throw new Error(`usbmuxd: ${CONNECT_ERRORS[reply.Number] || 'connect failed ' + reply.Number} (device port ${port})`);
  }
  if (rest.length) sock.unshift(rest);
  return sock;
}

// Listen on host:localPort and forward every connection to devicePort on the device.
export function startForwarder({ udid, localPort = 8100, devicePort = 8100, host = '127.0.0.1', socketPath = USBMUXD_SOCKET, onError = () => {} }) {
  const server = net.createServer((client) => {
    client.pause();
    client.on('error', () => {});
    connectDevice(udid, devicePort, { socketPath })
      .then((dev) => {
        dev.on('error', () => client.destroy());
        client.on('close', () => dev.destroy());
        dev.on('close', () => client.destroy());
        dev.pipe(client);
        client.pipe(dev);
        dev.resume();
        client.resume();
      })
      .catch((e) => {
        onError(e);
        client.destroy();
      });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(localPort, host, () => resolve(server));
  });
}

export const usbmuxAvailable = (socketPath = USBMUXD_SOCKET) => fs.existsSync(socketPath);
