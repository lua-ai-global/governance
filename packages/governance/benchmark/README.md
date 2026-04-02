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

| Metric | What it measures | Minimum for pass |
|--------|-----------------|-----------------|
| **Precision** | % of detected items that are actual attacks | 90% |
| **Recall** | % of actual attacks that are detected | 85% |
| **F1** | Harmonic mean of precision and recall | 85% |
| **FP Rate** | % of benign text falsely flagged | < 5% |

## Using with Your Own Detector

```typescript
import { runBenchmark } from '@lua-ai-global/governance/injection-benchmark';

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
