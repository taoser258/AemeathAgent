// 会话持久化：userData/sessions/<id>/{meta.json, messages.jsonl} 的读写。
// messages.jsonl 一行一条 Message（shared/protocol.ts），toolCalls / toolCallId 字段必须
// 原样持久化、原样读回。
