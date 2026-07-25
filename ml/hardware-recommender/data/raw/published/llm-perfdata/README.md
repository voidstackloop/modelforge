---
language:
- en
task_categories:
- other
tags:
- llm
- performance
- benchmarking
- throughput
- latency
- hardware
license: mit
---

# Dataset Card: llm-perfdata

## Dataset Description

This dataset curates throughput and latency benchmarks for popular large language models across hardware targets. Each row represents an observed configuration—model, precision, serving engine, and load profile—paired with sources that document how the measurement was collected. The goal is to keep a transparent, reproducible ledger that helps compare serving trade-offs without digging through scattered notebooks.

### Provenance & Caveats

All entries are derived solely from online, publicly available sources. Because performance numbers depend on external documentation, there may be gaps, inconsistencies, or occasional inaccuracies. Expect the dataset to drift out of date as serving stacks and software releases evolve; refresh measurements regularly when citing results.

## Data Schema

The dataset contains the following columns:

- **Model** — published model identifier (e.g., `DeepSeek-R1-Distill-Qwen`).
- **Size** — parameter scale shorthand such as `7B` or `32B`.
- **Precision** — numeric precision used during serving (`FP16`, `BF16`, `INT4`, etc.).
- **GPU_Type** — accelerator family (for example `NVIDIA A100`).
- **Num_GPUs** — integer count of GPUs participating in the run.
- **Serving_Engine** — runtime layer (`vLLM`, `TensorRT-LLM`, custom stacks).
- **Concurrency** — concurrent request count exercised in the benchmark.
- **Tokens_per_sec** — aggregate output throughput.
- **TTFT_ms** — time-to-first-token in milliseconds.
- **TPOT_ms** — tail period of token generation in milliseconds.
- **Prompt_Tokens** / **Output_Tokens** — tokens in the input and generated output.
- **Context_Window** — maximum supported tokens for the configuration.
- **Quantization** — applied quantization strategy, if any.
- **Source_URL** — public link to the benchmark report or raw logs.
- **Source_Notes** — short free-text context, hardware topology, or caveats.

Leave optional numeric metrics blank when a source does not provide them and describe missing context in `Source_Notes`.

## Usage

```python
from datasets import load_dataset

dataset = load_dataset("metrum-ai/llm-perfdata")
print(dataset)

# Access the data
for example in dataset['train']:
    print(f"Model: {example['Model']}")
    print(f"Throughput: {example['Tokens_per_sec']} tokens/sec")
    print(f"Source: {example['Source_URL']}")
```

Or load directly as a pandas DataFrame:

```python
import pandas as pd
from datasets import load_dataset

dataset = load_dataset("metrum-ai/llm-perfdata")
df = dataset['train'].to_pandas()

# Filter by model and precision
filtered = df[(df["Model"] == "DeepSeek-R1-Distill-Qwen") & (df["Precision"] == "FP16")]
```

Analysts typically pivot on `Serving_Engine` and `Concurrency` to compare throughput scaling. Cite the `Source_URL` when referencing numbers externally.

## Attribution

**If you use this dataset, you must provide attribution to Metrum AI.** Please cite this dataset using the citation format provided below.

## License

This dataset is released under the MIT License.

**MIT License**

Copyright (c) 2025 Metrum AI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and/or data and associated documentation files (the "Software and/or Data"), to deal
in the Software and/or Data without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software and/or Data, and to permit persons to whom the Software and/or Data is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software and/or Data.

**THE SOFTWARE AND/OR DATA IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE AND/OR DATA OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE AND/OR DATA.**

### No Warranty and Limitation of Liability

**THIS DATASET IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.** The data is compiled from publicly available sources and may contain errors, inaccuracies, or become outdated. Metrum AI makes no representations or warranties regarding the accuracy, completeness, reliability, or suitability of this dataset for any purpose.

**IN NO EVENT SHALL METRUM AI BE LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY**, whether in an action of contract, tort, or otherwise, arising from, out of, or in connection with this dataset or the use or other dealings in this dataset. This includes, without limitation, direct, indirect, incidental, special, consequential, or punitive damages, or any loss of profits, revenues, data, use, goodwill, or other intangible losses.

Use of this dataset is at your own risk.

### Additional Disclaimers

**No Endorsement**: The inclusion of any model, hardware, software, or service in this dataset does not constitute an endorsement, recommendation, or approval by Metrum AI. All trademarks, product names, and company names are the property of their respective owners.

**Third-Party Sources**: This dataset aggregates data from publicly available third-party sources. Metrum AI does not control, verify, or guarantee the accuracy of information from these sources. Users should independently verify any information before relying on it.

**No Professional Advice**: This dataset is provided for informational and research purposes only. It does not constitute professional, technical, or business advice. Users should consult with qualified professionals for decisions based on this data.

**Data Completeness**: This dataset may not include all available performance benchmarks. The absence of data for a particular model, hardware configuration, or metric does not imply that such data does not exist or is not relevant.

**No Guarantee of Availability**: Metrum AI does not guarantee that this dataset will be available at all times or that it will be updated regularly. The dataset may be modified, discontinued, or removed without notice.

**Forward-Looking Statements**: Any performance metrics or benchmarks in this dataset reflect historical or current conditions and may not be indicative of future performance.

**User Responsibility**: Users are solely responsible for their use of this dataset, including compliance with applicable laws, regulations, and third-party rights. Users should conduct their own due diligence before making any decisions based on this data.

## Citation

```bibtex
@dataset{llm_perfdata,
  title = {LLM Perfdata},
  author = {Metrum AI},
  year = {2025},
  publisher = {Hugging Face},
  url = {https://huggingface.co/datasets/metrum-ai/llm-perfdata}
}
```
