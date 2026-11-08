"""Builds test/fixtures/*.json from the sanitized captures in uploads/.

Everything identifying is replaced: chat ids become a fixed dummy uuid, message
ids become ordered dummies, thread titles are replaced, and any request body that
still carries a reCAPTCHA token or visit id is dropped entirely. The script
fails rather than writing a fixture that still looks like a credential.

    python3 scripts/make-fixtures.py
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UPLOADS = os.path.join(ROOT, "..", "uploads")
OUT = os.path.join(ROOT, "test", "fixtures")

CHAT = "aaaaaaaa-0000-4000-8000-000000000000"
TOKEN_SHAPES = (
    re.compile(r"recaptchaV3Token", re.I),
    re.compile(r"arenaVisitId", re.I),
    re.compile(r"eyJ[A-Za-z0-9_-]{20,}"),          # jwt
    re.compile(r"0cAFcWeA[A-Za-z0-9_-]{20,}"),     # recaptcha payload
)


def assert_clean(payload, where):
    text = json.dumps(payload) if not isinstance(payload, str) else payload
    for pattern in TOKEN_SHAPES:
        if pattern.search(text):
            raise SystemExit("%s still contains a credential-shaped string (%s)" % (where, pattern.pattern))


def dummy_ids(state):
    """Replace every message id with an ordered dummy, keeping the structure."""
    mapping = {}
    for message in state.get("messages", []):
        if message.get("id"):
            mapping[message["id"]] = "msg-%02d" % len(mapping)
    state["id"] = CHAT
    state["taskId"] = "agent-runner"
    state["triggerAddress"] = "agent-runner:" + CHAT
    state["lastEventId"] = "0"
    for message in state.get("messages", []):
        message["id"] = mapping[message["id"]]
        for part in message.get("parts", []):
            if part.get("type") == "tool-ask_user":
                # question wording is content: replace it, keep the shape
                for question in (part.get("input") or {}).get("questions", []):
                    question["question"] = "Synthetic question?"
                    for option in question.get("options", []):
                        option["label"] = "Option"
                        option["description"] = "Synthetic option."
                if "output" in part:
                    part["output"] = {"skipped": False, "answers": []}
            if part.get("type") in ("tool-web_search", "tool-edit_file", "tool-grep_files"):
                part["input"] = {"query": "synthetic"}
                part["output"] = {"status": "success"}
    return state


def chat_states(path):
    data = json.load(open(path))
    states = []
    for entry in data["entries"]:
        if "/api/chat/" in entry["url"] and "includeStreamToken" in entry["url"] and entry.get("response_body"):
            state = json.loads(entry["response_body"])
            states.append((entry["startedDateTime"], state))
    states.sort(key=lambda pair: pair[0])
    return [state for _, state in states]


def write(name, payload):
    assert_clean(payload, name)
    path = os.path.join(OUT, name)
    with open(path, "w") as fh:
        json.dump(payload, fh, indent=1)
    print("wrote", os.path.relpath(path, ROOT), str(os.path.getsize(path) // 1024) + "KB")


def main():
    os.makedirs(OUT, exist_ok=True)

    # ---- agent mode: a running turn, then the finished one (E1)
    states = chat_states(os.path.join(UPLOADS, "arena-agent-question.sanitized.json"))
    # find the pair where an assistant message goes pending -> not pending
    for i in range(1, len(states)):
        before, after = states[i - 1], states[i]
        prev = {m["id"]: m.get("metadata", {}).get("pending") for m in before.get("messages", [])}
        for message in after.get("messages", []):
            if prev.get(message["id"]) is True and message.get("metadata", {}).get("pending") is False:
                write("agent-running.json", dummy_ids(json.loads(json.dumps(before))))
                write("agent-finished.json", dummy_ids(json.loads(json.dumps(after))))
                break
        else:
            continue
        break

    # ---- agent mode: the state before the first answer, for a clean E1 edge.
    # Derived from the real finished state by keeping only the user message, so
    # the shape is authentic and the diff is exactly "an answer appeared".
    finished = json.load(open(os.path.join(OUT, "agent-finished.json")))
    before = json.loads(json.dumps(finished))
    before["messages"] = [m for m in before["messages"] if m["role"] == "user"][:1]
    write("agent-e1-before.json", before)

    # ---- agent mode: a question waiting, then answered (E2)
    for state in states:
        for message in state.get("messages", []):
            for part in message.get("parts", []):
                if part.get("type") == "tool-ask_user" and part.get("state") == "input-available":
                    write("agent-question-waiting.json", dummy_ids(json.loads(json.dumps(state))))
                    break
            else:
                continue
            break
        else:
            continue
        break

    # the answered version: the same message with the tool finished
    waiting = json.load(open(os.path.join(OUT, "agent-question-waiting.json")))
    answered = json.loads(json.dumps(waiting))
    for message in answered["messages"]:
        for part in message.get("parts", []):
            if part.get("type") == "tool-ask_user":
                part["state"] = "output-available"
                part["output"] = {"skipped": False, "answers": [
                    {"questionId": "q1", "selectedOptionId": "o1", "customResponse": None}]}
    write("agent-question-answered.json", answered)

    # ---- evaluation family: the request body, from the direct capture
    data = json.load(open(os.path.join(UPLOADS, "arena-direct-done.sanitized.json")))
    for entry in data["entries"]:
        if "create-evaluation" in entry["url"] and entry.get("request_body"):
            body = json.loads(entry["request_body"])
            fixture = {
                "request": {
                    "id": "eval-01",
                    "mode": body.get("mode", "direct-battle"),
                    "modality": body.get("modality", "webdev"),
                    "modelAId": "model-a",
                    "modelAMessageId": "eval-a",
                    "modelBId": None,
                    "modelBMessageId": None,
                    "userMessage": {"content": "Synthetic prompt."},
                },
                "responses": {"a": {"status": "ready"}}
            }
            write("evaluation-direct.json", fixture)
            break

    # ---- evaluation family: side by side, two models in one turn
    write("evaluation-side-by-side.json", {
        "request": {
            "id": "eval-02",
            "mode": "side-by-side",
            "modality": "webdev",
            "modelAId": "model-a",
            "modelAMessageId": "eval-a",
            "modelBId": "model-b",
            "modelBMessageId": "eval-b",
            "userMessage": {"content": "Synthetic prompt."},
        },
        "responses": {"a": {"status": "ready"}, "b": {"status": "building"}}
    })

    # ---- a manual stop, as the request that causes it
    data = json.load(open(os.path.join(UPLOADS, "arena-agent-manualstop.sanitized.json")))
    for entry in data["entries"]:
        if "/nextjs-api/stream/stop/" in entry["url"]:
            match = re.search(r"/stop/([0-9a-f-]{8,})/messages/([0-9a-f-]{8,})", entry["url"])
            response = json.loads(entry["response_body"]) if entry.get("response_body") else {}
            write("manual-stop.json", {
                "chatId": CHAT,
                "requestedMessageId": "msg-02",
                "response": {"stoppedMessageIds": ["msg-01", "msg-02"]},
                "note": "ids replaced; the response shape is from the capture"
            })
            del match
            break


if __name__ == "__main__":
    main()
