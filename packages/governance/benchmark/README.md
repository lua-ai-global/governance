# Lua Injection Benchmark (LIB)

Industry benchmark for prompt injection detection. Multi-source, multi-category, with hard negatives and encoding attacks.

## Quick Start

```bash
# Build the full dataset from scratch (fetches external sources + generates samples)
npx tsx benchmark/scripts/run-pipeline.ts

# Run benchmark against the built-in regex detector
npx tsx benchmark/scripts/run-benchmark.ts

# Run with custom threshold
npx tsx benchmark/scripts/run-benchmark.ts --threshold=0.6

# Output machine-readable JSON
npx tsx benchmark/scripts/run-benchmark.ts --json
```

## Pipeline Steps

| Step | Script | Description |
|------|--------|-------------|
| 1 | `fetch-datasets.ts` | Fetch from HuggingFace (deepset, jackhhao, hackaprompt, Harelix) |
| 2 | `generate-encoding-attacks.ts` | Generate base64, hex, unicode, ROT13, leetspeak attacks |
| 3 | `generate-hard-negatives.ts` | Generate 80+ benign samples with injection trigger words |
| 4 | `merge-datasets.ts` | Merge, deduplicate, balance (target: 2000 samples) |
| 5 | `validate-labels.ts` | Multi-detector consensus validation |
| 6 | `build-final-dataset.ts` | Package as LIB v1.0.0 |
| 7 | `run-benchmark.ts` | Run detector and report metrics |

## Dataset Composition

- **External sources**: deepset/prompt-injections, jackhhao/jailbreak-classification, hackaprompt, Harelix mixed techniques
- **Generated encoding attacks**: 130 samples (10 payloads x 13 encodings)
- **Generated hard negatives**: 80+ business/technical samples with trigger words
- **Attack categories**: instruction_override, role_manipulation, context_escape, data_exfiltration, encoding_attack, social_engineering, obfuscation, multi_vector
- **Benign categories**: hard_negative (trigger words), business (normal text), meta_discussion (talking about injection)

## Metrics

The benchmark reports precision, recall, F1, and false-positive rate.
There is no fixed pass threshold — judge your detector against the
shipped regex baseline below and the trade-off you need.

### Current baseline — `governance-sdk/injection-detect` (54-pattern regex)

Generated against LIB v1 (6,931 samples; 2,096 attacks, 4,835 benign).
See `data/lua-injection-benchmark-v1-regex-baseline.json`.

| Metric        | Value   |
|---------------|---------|
| Precision     | 0.685   |
| Recall        | 0.373   |
| F1            | 0.483   |
| Accuracy      | 0.758   |
| FP Rate       | 0.074   |

The shipped regex detector is a high-precision / low-recall first
layer — useful as defense-in-depth, not a sole control. Plug in an
ML classifier via `createInjectionGuard({ classifier })` to lift recall.

## Using with Your Own Detector

```typescript
import { runBenchmark } from 'governance-sdk/injection-benchmark';

const results = await runBenchmark(async (input) => {
  // Your detector here
  const response = await myMLModel.classify(input);
  return { detected: response.isInjection, score: response.confidence };
});

console.log(results.summary);
```

## Contributing Samples

Add samples to the dataset by editing the generator scripts or submitting labeled JSONL:

```json
{"text": "your sample text", "label": "injection", "category": "instruction_override", "source": "community"}
```

## License

MIT — same as the governance SDK.
