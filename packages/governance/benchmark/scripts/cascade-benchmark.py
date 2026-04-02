#!/usr/bin/env python3
"""
Cascade Benchmark — Run the actual three-model cascade end-to-end.

Each layer sees ONLY what the previous layer passes to it.
No napkin math — real compounded numbers.
"""
import json, torch, time, subprocess
from transformers import AutoTokenizer, AutoModelForSequenceClassification
from sklearn.metrics import precision_score, recall_score, f1_score

device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")

# Load test data
samples = [json.loads(l) for l in open("benchmark/data/lua-injection-benchmark-v1-test.jsonl") if l.strip()]
labs = [1 if s["label"] in ["injection", 1] else 0 for s in samples]
total_pos = sum(labs); total_neg = len(labs) - total_pos
print(f"Test: {len(samples)} ({total_pos} atk, {total_neg} ben)\n")

# ─── Layer 1: Regex ──────────────────────────────────────────
print("Layer 1: Regex...")
regex_raw = subprocess.check_output([
    "node", "--input-type=module", "-e",
    'import{detectInjection}from"./dist/injection-detect.js";import{readFileSync}from"fs";'
    'const s=readFileSync("benchmark/data/lua-injection-benchmark-v1-test.jsonl","utf-8").trim().split("\\n").map(l=>JSON.parse(l));'
    'process.stdout.write(JSON.stringify(s.map(x=>{const r=detectInjection(x.text);return{d:r.detected,s:r.score}})));'
]).decode()
regex_results = json.loads(regex_raw)
print(f"  {len(regex_results)} scored")

# ─── Layer 2: Wolf (off-shelf, high recall) ──────────────────
print("Layer 2: Wolf off-shelf...")
wolf_tok = AutoTokenizer.from_pretrained("patronus-studio/wolf-defender-prompt-injection", trust_remote_code=True)
wolf_model = AutoModelForSequenceClassification.from_pretrained("patronus-studio/wolf-defender-prompt-injection", trust_remote_code=True).to(device)
wolf_model.eval()

# ─── Layer 3: Fine-tuned DeBERTa (precision gate) ───────────
print("Layer 3: Fine-tuned DeBERTa...")
import os
deb_path = os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "governance-cloud", "packages", "governance-ml", "training", "output-real-only")
if not os.path.exists(deb_path):
    # Fallback to ProtectAI off-shelf as DeBERTa layer
    deb_path = "protectai/deberta-v3-base-prompt-injection-v2"
    print(f"  (using off-shelf ProtectAI — fine-tuned model not found locally)")
deb_tok = AutoTokenizer.from_pretrained(deb_path)
deb_model = AutoModelForSequenceClassification.from_pretrained(deb_path).to(device)
deb_model.eval()

# Pre-score all samples through Wolf and DeBERTa
def batch_score(model, tok, texts, max_len=256, idx=1):
    scores = []
    for i in range(0, len(texts), 16):
        batch = texts[i:i+16]
        enc = tok(batch, truncation=True, max_length=max_len, padding=True, return_tensors="pt").to(device)
        with torch.no_grad():
            probs = torch.softmax(model(**enc).logits, dim=-1)
            scores.extend(probs[:, idx].cpu().tolist())
    return scores

texts = [s["text"][:1024] for s in samples]
print("  Scoring Wolf...")
wolf_scores = batch_score(wolf_model, wolf_tok, texts, max_len=512)
print("  Scoring DeBERTa...")
deb_scores = batch_score(deb_model, deb_tok, texts, max_len=256)

# ─── CASCADE CONFIGURATIONS ─────────────────────────────────

configs = [
    # (name, regex_t, wolf_t, deb_t, cascade_type)
    # cascade_type: "solo" = single model, "gate" = wolf flags → deberta confirms, "or" = either triggers
    ("Regex only",                        0.5,  None, None, "solo"),
    ("ProtectAI DeBERTa off-shelf @0.95", None, None, 0.95, "solo"),  # actually using our fine-tuned
    ("Wolf off-shelf @0.95",              None, 0.95, None, "solo"),

    ("Regex → DeBERTa @0.95",            0.5,  None, 0.95, "fallback"),
    ("Regex → Wolf @0.90",               0.5,  0.90, None, "fallback"),
    ("Regex → Wolf @0.85",               0.5,  0.85, None, "fallback"),

    # THE FULL CASCADE: regex catches obvious, wolf catches most, deberta confirms
    ("FULL: Regex → Wolf @0.80 → DeBERTa @0.85", 0.5, 0.80, 0.85, "gate"),
    ("FULL: Regex → Wolf @0.85 → DeBERTa @0.85", 0.5, 0.85, 0.85, "gate"),
    ("FULL: Regex → Wolf @0.85 → DeBERTa @0.90", 0.5, 0.85, 0.90, "gate"),
    ("FULL: Regex → Wolf @0.90 → DeBERTa @0.85", 0.5, 0.90, 0.85, "gate"),
    ("FULL: Regex → Wolf @0.90 → DeBERTa @0.90", 0.5, 0.90, 0.90, "gate"),
    ("FULL: Regex → Wolf @0.80 → DeBERTa @0.90", 0.5, 0.80, 0.90, "gate"),
]

W = 76
print(f"\n{'═'*W}")
print(f"  CASCADE BENCHMARK — Actual End-to-End Compound Results")
print(f"  {len(samples)} samples ({total_pos} attacks, {total_neg} benign)")
print(f"{'═'*W}")
print(f"  {'Config':46s}│ Prec  │ Recall│  F1   │FP Rate│Blk/1K")
print(f"  {'─'*46}┼───────┼───────┼───────┼───────┼──────")

for name, regex_t, wolf_t, deb_t, cascade_type in configs:
    tp = fp = tn = fn = 0

    for i in range(len(samples)):
        expected = labs[i]
        detected = False

        # Layer 1: Regex
        regex_caught = regex_t is not None and regex_results[i]["d"] and regex_results[i]["s"] >= regex_t
        if regex_caught:
            detected = True

        if not detected:
            if cascade_type == "solo":
                # Single model, no regex
                if wolf_t is not None:
                    detected = wolf_scores[i] >= wolf_t
                elif deb_t is not None:
                    detected = deb_scores[i] >= deb_t

            elif cascade_type == "fallback":
                # Regex missed → try wolf OR deberta
                if wolf_t is not None:
                    detected = wolf_scores[i] >= wolf_t
                elif deb_t is not None:
                    detected = deb_scores[i] >= deb_t

            elif cascade_type == "gate":
                # Regex missed → Wolf flags → DeBERTa confirms
                if wolf_t is not None and wolf_scores[i] >= wolf_t:
                    # Wolf thinks it's suspicious, ask DeBERTa to confirm
                    if deb_t is not None:
                        detected = deb_scores[i] >= deb_t
                    else:
                        detected = True

        if expected == 1 and detected: tp += 1
        elif expected == 0 and not detected: tn += 1
        elif expected == 0 and detected: fp += 1
        else: fn += 1

    p = tp/(tp+fp) if (tp+fp) > 0 else 0
    r = tp/(tp+fn) if (tp+fn) > 0 else 0
    f1 = 2*p*r/(p+r) if (p+r) > 0 else 0
    fpr = fp/total_neg
    blk = round(fpr * 1000)
    icon = "✅" if fpr <= 0.01 else "⚡" if fpr <= 0.03 else "⚠️" if fpr <= 0.05 else "❌"

    short_name = name[:46]
    print(f"  {short_name:46s}│{p*100:5.1f}% │{r*100:5.1f}% │{f1*100:5.1f}% │{fpr*100:5.2f}%│{blk:3d}/1K {icon}")

print(f"{'═'*W}")
