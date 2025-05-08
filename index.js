import fs from 'fs'
import FileType from 'file-type'
import pkg from '@whiskeysockets/baileys'
const { 
    makeWASocket, 
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    downloadContentFromMessage,
    DisconnectReason,
    jidDecode,
    Browsers
} = pkg
import { Boom } from '@hapi/boom'
import pino from 'pino'
import readline from 'readline'

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

const processedMessages = new Set()
const usePairingCode = process.argv.includes('--use-pairing-code')
const prefix = '!'

function decodeJid(jid) {
    if (/:\d+@/gi.test(jid)) {
        const decode = jidDecode(jid) || {}
        return (decode.user && decode.server ? `${decode.user}@${decode.server}` : jid).trim()
    }
    return jid.trim()
}

const MediaType = [
    'imageMessage',
    'videoMessage',
    'audioMessage',
    'stickerMessage',
    'documentMessage',
    'ptvMessage'
]

const serialize = (m, conn) => {
    conn.downloadAndSaveMediaMessage = async (
        message,
        filename,
        attachExtension = true
    ) => {
        let quoted = message.msg ? message.msg : message
        let mime = (message.msg || message).mimetype || ""
        let messageType = message.mtype
            ? message.mtype.replace(/Message/gi, "")
            : mime.split("/")[0]
        const stream = await downloadContentFromMessage(quoted, messageType)
        let buffer = Buffer.from([])
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk])
        }
        let type = await FileType.fromBuffer(buffer)
        trueFileName = attachExtension ? filename + "." + type.ext : filename
        await fs.writeFileSync(trueFileName, buffer)
        return trueFileName
    }

    if (m.message) {
        m.id = m.key.id
        m.from = m.key.remoteJid
        m.type = Object.keys(m.message).find(type =>
            type !== 'senderKeyDistributionMessage' &&
            type !== 'messageContextInfo'
        )
        m.sender = decodeJid(
            m.key?.fromMe && conn?.user.id ||
            m.participant ||
            m.key.participant ||
            m.from ||
            ''
        )

        let message = m.message
        if (['viewOnceMessageV2', 'interactiveMessage', 'documentWithCaptionMessage'].includes(m.type)) {
            message = m.message[m.type]?.header || m.message[m.type]?.message || false
            if (message) m.typeV2 = Object.keys(message)[0]
        }

        m.text = message?.conversation ||
            message[m.type]?.text ||
            message[m.type]?.caption ||
            message[m?.typeV2]?.caption ||
            message[m.type]?.selectedId ||
            message[m.type]?.name ||
            m.message[m.type]?.body?.text ||
            ''
        m.mentions = (message[m.typeV2] || message[m.type])?.contextInfo?.mentionedJid || []
        m.expiration = (message[m.typeV2] || message[m.type])?.contextInfo?.expiration || 0
        let isMedia = MediaType.some(type => {
            let m = message[type]
            return m?.url || m?.directPath
        })
        if (isMedia) {
            m.media = message[m.typeV2] || message[m.type] || null
            m.download = () => downloadMediaMessage(message)
        }
    }
    if (!m.quoted) m.quoted = {}
    m.quoted.message = m.message[m.type]?.contextInfo?.quotedMessage || null
    if (m.quoted.message) {
        m.quoted.key = {
            remoteJid: m.message[m.type]?.contextInfo?.remoteJid || m.from || m.sender,
            fromMe: decodeJid(m.message[m.type]?.contextInfo?.participant) === conn.user.jid,
            id: m.message[m.type]?.contextInfo?.stanzaId,
            participant: decodeJid(m.message[m.type]?.contextInfo?.participant) || m.sender
        }
        m.quoted.id = m.quoted.key.id
        m.quoted.from = m.quoted.key.remoteJid
        m.quoted.type = Object.keys(m.quoted.message).find(type =>
            type !== 'senderKeyDistributionMessage' &&
            type !== 'messageContextInfo'
        )
        m.quoted.sender = m.quoted.key.participant
        if (m.quoted) {
            let message = m.quoted.message
            if (['viewOnceMessageV2', 'interactiveMessage', 'documentWithCaptionMessage'].includes(m.quoted.type)) {
                message = m.quoted.message[m.quoted.type]?.header || m.quoted.message[m.quoted.type]?.message || false
                if (message) m.quoted.typeV2 = Object.keys(message)[0]
            }
            m.quoted.text = message?.conversation ||
                message[m.quoted.type]?.text ||
                message[m.quoted.type]?.caption ||
                message[m.quoted.typeV2]?.caption ||
                message[m.quoted.type]?.selectedId ||
                message[m.quoted.type]?.name ||
                m.quoted.message[m.quoted.type]?.body?.text ||
                ''
            m.quoted.mentions = (message[m.quoted.typeV2] || message[m.quoted.type])?.contextInfo?.mentionedJid || []
            let isMedia = MediaType.some(type => {
                let m = message[type]
                return m?.url || m?.directPath
            })
            if (isMedia) {
                m.quoted.media = message[m.quoted.typeV2] || message[m.quoted.type] || null
                m.quoted.download = () => downloadMediaMessage(message)
            }
        }
    } else {
        m.quoted = false
    }

    m.reply = async (textOrOpts, opts = {}) => {
        let text = null
        let options = {}
        if (textOrOpts === null) {
            options = opts
        } else if (typeof textOrOpts === 'string') {
            text = textOrOpts
            options = opts
        } else {
            options = textOrOpts
            text = options?.text || null
        }
        let from = options?.from || m.from
        let quoted = options?.quoted !== undefined ? options.quoted : m
        if (options?.mentions) {
            options.mentions = Array.isArray(options.mentions)
                ? options.mentions
                : [...text.matchAll(/@([0-9]{5,16}|0)/g)].map(v => v[1] + '@s.whatsapp.net')
        }
        let messageId = null, expiration = null, content
        if (m.expiration) {
            expiration = { ephemeralExpiration: options?.expiration || m.expiration }
            if (options?.expiration) delete options.expiration
        }

        if (options?.media) {
            const { mime, buffer } = await getFile(options.media)
            let mtype = ''
            if (/webp/.test(mime)) mtype = 'sticker'
            else if (/image/.test(mime)) mtype = 'image'
            else if (/video/.test(mime)) mtype = (Buffer.byteLength(buffer) >= 104857600 ? 'document' : 'video')
            else if (/audio/.test(mime)) mtype = 'audio'
            else if (/apk/.test(mime)) mtype = 'document'
            else mtype = 'document'
            delete options.media
            content = { [mtype]: buffer, caption: text, mimetype: mime, ...options }
        } else if (options?.image || options?.video || options?.document || options?.sticker || options?.audio) {
            let mediaType = Object.keys(options).find(key => ['image', 'video', 'document', 'sticker', 'audio'].includes(key))
            content = { caption: text, ...options, [mediaType]: (await getFile(options[mediaType])).buffer }
        } else if (options?.delete || options?.forward) {
            content = { ...options }
        } else {
            content = { ...(text && { text }), ...options }
        }

        if (options?.id) messageId = options.id
        return conn.sendMessage(from, content, { quoted, ...expiration, messageId })
    }

    m.react = (emoji, opts = {}) => {
        let key = opts.key || m.key
        return conn.sendMessage(m.from, { react: { text: emoji, key } })
    }

    return m
}

async function connectSock() {
    console.log('Starting connection...')
    const { state, saveCreds } = await useMultiFileAuthState('session', pino({ level: 'fatal' }))
    const { version, isLatest } = await fetchLatestBaileysVersion()
    console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`)

    const conn = makeWASocket({
        version: [2, 3000, 1015901307],
        printQRInTerminal: !usePairingCode,
        logger: pino({ level: 'fatal' }),
        browser: Browsers.appropriate("firefox"),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
        }
    })

    conn.ev.on('creds.update', async () => {
        await saveCreds()
    })

    if (usePairingCode && !conn.authState.creds.registered) {
        setTimeout(async () => {
            rl.question(
                `Enter the phone number for the bot in this format 6282xxxxxxxx.\nNumber: `,
                async function (phoneNumber) {
                    await conn.waitForConnectionUpdate((update) => !!update.qr)
                    let code = await conn.requestPairingCode(phoneNumber.replace(/\D/g, ''))
                    console.log(`\nCode: ${code.match(/.{1,4}/g)?.join('-')}\n`)
                    rl.close()
                }
            )
        }, 3000)
    }

    conn.ev.on('messages.upsert', async ({ messages }) => {
        let m = messages[messages.length - 1]
        if (!m.message) return

        try {
            if (processedMessages.has(m.key.id)) return
            processedMessages.add(m.key.id)
            const msg = serialize(m, conn)
            if (msg.text.startsWith(prefix)) {
                const command = msg.text.slice(prefix.length).trim().split(" ")[0]
                const args = msg.text.split(" ").slice(1)

                console.log(`cmd: ${command}, args: ${args.join(", ")}`)

                const commands = {
                    tes: async () => {
                        const response = { text: 'hehe' }
                        await conn.sendMessage(msg.from, response, { quoted: msg })
                    },
                    ping: async () => {
                        const response = { text: 'Pong!' }
                        await conn.sendMessage(msg.from, response, { quoted: msg })
                    },
                    default: async () => {
                        const response = { text: 'Command not recognized!' }
                        await conn.sendMessage(msg.from, response, { quoted: msg })
                    }
                }

                await (commands[command] || commands.default)()
            } 
            setTimeout(() => processedMessages.delete(m.key.id), 420000)
        } catch (e) {
            console.error('Error processing message:', e)
        }
    })

    conn.ev.on('connection.update', async (update) => {
        const { lastDisconnect, connection } = update

        console.log(`Connection update: ${connection}`)

        if (!usePairingCode && update.qr) {
            console.log('Scan QR, expires in 60 seconds.')
        }

        if (connection === 'open') {
            console.log('Connected')
        }

        if (connection === 'close') {
            console.log('Disconnecting')
            const shouldReconnect =
                lastDisconnect.error instanceof Boom
                    ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                    : true

            if (shouldReconnect) {
                connectSock()
            } 
        }
    })

    return conn
}

connectSock()