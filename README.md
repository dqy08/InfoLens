---
title: Info Lens
emoji: 🔭
colorFrom: blue
colorTo: red
sdk: docker
short_description: Explore the informational nature of LLMs and language.
tags:
  - llm-interpretability
  - text-analysis
  - information
  - visualization
app_port: 7860
pinned: false
license: apache-2.0
---

# Info Lens

**Info Lens** is a small toolbox for exploring the informational nature of LLMs and language.
- Source: [github.com/dqy08/InfoLens](https://github.com/dqy08/InfoLens)
- Live demo: [huggingface.co/spaces/dqy08/InfoLens](https://huggingface.co/spaces/dqy08/InfoLens)

<img src="client/src/assets/images/dag-dark.gif" width="460" alt="LLM Causal Flow" />

<img src="client/src/assets/images/dag-cot.gif" width="460" alt="Chain-of-thought" />

## 📦 Quick Start

### Using Docker (Recommended)

This is the simplest way to run Info Lens:

```bash
# 1. Build the image
docker build -t inforadar .

# 2. Run the container (Map port to 7860)
docker run -p 7860:7860 inforadar
```
Once running, visit `http://localhost:7860` in your browser.

### Local Development

**Frontend Build** 

```bash
cd client/src && npm ci && npm run build
```

**Backend Environment**:

```bash
pip install -r requirements.txt
python run.py
```

Visit `http://localhost:5001` in your browser.

## Legacy name: InfoRadar

InfoRadar is the former project and repo name. It still appears in parts of the codebase. 

## 📜 License

Apache 2.0. Copyright and attribution: see [NOTICE](NOTICE).

