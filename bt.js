const b = require('@yudzxml/baileys'), make = b.default
const num = process.argv[2]
const run = (name, opts, pair) => new Promise(async res => {
  const { state } = await b.useMultiFileAuthState('./bt_' + name)
  const sock = make({ auth: state, ...opts })
  let done = false
  const fin = r => { if (done) return; done = true; try { sock.end(undefined) } catch (e) {} console.log(name, '=>', r); setTimeout(res, 2000) }
  sock.ev.on('connection.update', async u => {
    if (u.qr) {
      if (!pair) return fin('QR OK')
      try { fin('CODE ' + await sock.requestPairingCode(num)) } catch (e) { fin('PAIR ERR ' + e.message) }
    }
    if (u.connection === 'close') fin('CLOSED ' + u.lastDisconnect?.error?.output?.statusCode)
  })
  setTimeout(() => fin('TIMEOUT'), 12000)
})
;(async () => {
  let v; try { v = (await b.fetchLatestWaWebVersion({})).version } catch (e) {}
  const mac = ['Mac OS', 'Desktop', '14.0.0'], ub = ['Ubuntu', 'Chrome', '22.04.4']
  await run('A_ubuntu', { browser: ub })
  await run('B_mac', { browser: mac })
  await run('C_mac_fetched_ver', { browser: mac, version: v })
  await run('D_ubuntu_pairing', { browser: ub }, true)
  process.exit()
})()
