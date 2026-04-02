#!/usr/bin/env python3
"""
Model Shootout — Benchmark multiple injection detection models
against our LLM-audited test set. Off-the-shelf, no fine-tuning.
"""
import json, torch, time, sys
from transformers import AutoTokenizer, AutoModelForSequenceClassification
from sklearn.metrics import precision_score, recall_score, f1_score

device = torch.device("mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu")

samples = [json.loads(l) for l in open("benchmark/data/lua-injection-benchmark-v1-test.jsonl") if l.strip()]
labs = [1 if s["label"] in ["injection", 1] else 0 for s in samples]
total_pos = sum(labs); total_neg = len(labs) - total_pos
print(f"Test: {len(samples)} samples ({total_pos} attacks, {total_neg} benign)\n")

MODELS = [
    ("protectai/deberta-v3-base-prompt-injection-v2", "ProtectAI DeBERTa v2 (baseline)"),
    ("vijil/vijil_dome_prompt_injection_detection", "Vijil DOME (ModernBERT)"),
    ("patronus-studio/wolf-defender-prompt-injection", "Patronus Wolf (mmBERT)"),
]

all_results = []

for model_id, name in MODELS:
    print(f"{'='*65}")
    print(f"  {name}")
    print(f"  {model_id}")
    print(f"{'='*65}")

    try:
        tok = AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)
        model = AutoModelForSequenceClassification.from_pretrained(model_id, trust_remote_code=True).to(device)
        model.eval()

        id2label = getattr(model.config, "id2label", {})
        print(f"  Labels: {id2label}")

        # Find injection label index
        inj_idx = 1
        for idx, label in id2label.items():
            upper = str(label).upper()
            if any(k in upper for k in ["INJECTION", "JAILBREAK", "UNSAFE", "MALICIOUS"]):
                inj_idx = int(idx)
        print(f"  Injection index: {inj_idx}")

        scores = []
        t0 = time.time()
        for i in range(0, len(samples), 16):
            batch = [s["text"][:1024] for s in samples[i:i+16]]
            ml = min(getattr(tok, "model_max_length", 512), 512)
            enc = tok(batch, truncation=True, max_length=ml, padding=True, return_tensors="pt").to(device)
            with torch.no_grad():
                probs = torch.softmax(model(**enc).logits, dim=-1)
                scores.extend(probs[:, inj_idx].cpu().tolist())
            if (i+16) % 500 < 16:
                sys.stdout.write(f"\r  Scoring... {min(i+16, len(samples))}/{len(samples)}")
                sys.stdout.flush()

        elapsed = time.time() - t0
        ms_per = elapsed * 1000 / len(samples)
        print(f"\r  Scored in {elapsed:.1f}s ({ms_per:.1f}ms/sample)              ")

        print(f"\n  Thresh │ Prec   │ Recall │  F1    │ FP Rate │ Status")
        print(f"  ───────┼────────┼────────┼────────┼─────────┼────────")

        best_ship = None
        for t in [0.5, 0.7, 0.8, 0.85, 0.9, 0.95]:
            pr = [1 if s >= t else 0 for s in scores]
            p = precision_score(labs, pr, zero_division=0)
            r = recall_score(labs, pr, zero_division=0)
            f = f1_score(labs, pr, zero_division=0)
            fp = sum(1 for pred, lab in zip(pr, labs) if pred == 1 and lab == 0)
            fpr = fp / total_neg if total_neg else 0
            status = "✅ SHIP" if fpr <= 0.01 else "⚡ close" if fpr <= 0.05 else ""
            if fpr <= 0.01 and (best_ship is None or f > best_ship["f1"]):
                best_ship = {"t": t, "p": p, "r": r, "f1": f, "fpr": fpr}
            print(f"   {t:.2f}  │ {p*100:5.1f}% │ {r*100:5.1f}% │ {f*100:5.1f}% │ {fpr*100:5.2f}%  │ {status}")

        all_results.append({"name": name, "ms": ms_per, "ship": best_ship})
        del model, tok

    except Exception as e:
        print(f"  FAILED: {e}")
        all_results.append({"name": name, "error": str(e)[:80]})

    print()

# Also add our fine-tuned model
print(f"{'='*65}")
print(f"  Our Fine-tuned DeBERTa (real-data + label smoothing)")
print(f"{'='*65}")
try:
    tok = AutoTokenizer.from_pretrained("benchmark/ml/output-real-only")
    model = AutoModelForSequenceClassification.from_pretrained("benchmark/ml/output-real-only").to(device)
    model.eval()
    scores = []
    t0 = time.time()
    for i in range(0, len(samples), 16):
        batch = [s["text"][:1024] for s in samples[i:i+16]]
        enc = tok(batch, truncation=True, max_length=256, padding=True, return_tensors="pt").to(device)
        with torch.no_grad():
            probs = torch.softmax(model(**enc).logits, dim=-1)
            scores.extend(probs[:, 1].cpu().tolist())
    elapsed = time.time() - t0
    ms_per = elapsed * 1000 / len(samples)
    print(f"  Scored in {elapsed:.1f}s ({ms_per:.1f}ms/sample)")
    print(f"\n  Thresh │ Prec   │ Recall │  F1    │ FP Rate │ Status")
    print(f"  ───────┼────────┼────────┼────────┼─────────┼────────")
    best_ship = None
    for t in [0.5, 0.7, 0.8, 0.85, 0.9, 0.95]:
        pr = [1 if s >= t else 0 for s in scores]
        p = precision_score(labs, pr, zero_division=0)
        r = recall_score(labs, pr, zero_division=0)
        f = f1_score(labs, pr, zero_division=0)
        fp = sum(1 for pred, lab in zip(pr, labs) if pred == 1 and lab == 0)
        fpr = fp / total_neg
        status = "✅ SHIP" if fpr <= 0.01 else "⚡ close" if fpr <= 0.05 else ""
        if fpr <= 0.01 and (best_ship is None or f > best_ship["f1"]):
            best_ship = {"t": t, "p": p, "r": r, "f1": f, "fpr": fpr}
        print(f"   {t:.2f}  │ {p*100:5.1f}% │ {r*100:5.1f}% │ {f*100:5.1f}% │ {fpr*100:5.2f}%  │ {status}")
    all_results.append({"name": "Our fine-tuned DeBERTa", "ms": ms_per, "ship": best_ship})
    del model, tok
except Exception as e:
    print(f"  FAILED: {e}")

# Final leaderboard
print(f"\n{'='*70}")
print(f"  LEADERBOARD — Best recall at ≤1% FP rate")
print(f"{'='*70}")
print(f"  {'Model':35s} │ Prec   │ Recall │  F1    │ FP Rate │ ms/sample")
print(f"  {'─'*35}─┼────────┼────────┼────────┼─────────┼──────────")

for r in sorted(all_results, key=lambda x: x.get("ship", {}).get("r", 0) if x.get("ship") else 0, reverse=True):
    if "error" in r:
        print(f"  {r['name']:35s} │ FAILED: {r['error'][:40]}")
    elif r.get("ship"):
        s = r["ship"]
        print(f"  {r['name']:35s} │ {s['p']*100:5.1f}% │ {s['r']*100:5.1f}% │ {s['f1']*100:5.1f}% │ {s['fpr']*100:5.2f}%  │ {r['ms']:.1f}ms")
    else:
        print(f"  {r['name']:35s} │ No threshold achieved ≤1% FP")

print(f"  {'─'*35}─┼────────┼────────┼────────┼─────────┼──────────")
print(f"  {'Regex (OSS baseline)':35s} │ 73.7%  │ 39.2%  │ 51.2%  │  6.30%  │  0.1ms")
print(f"{'='*70}")
