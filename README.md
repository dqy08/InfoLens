---
title: Info Lens
emoji: 🔭
colorFrom: blue
colorTo: red
sdk: docker
short_description: Explore the informational nature of LLMs and language.
tags:
  - nlp
  - text-analysis
  - information
  - visualization
  - reading-tools
app_port: 7860
pinned: false
license: apache-2.0
---

# Info Lens

**Info Lens** is a small toolbox for exploring the informational nature of LLMs and language.

## Legacy name: InfoRadar

InfoRadar is the former project and repo name. It still appears in parts of the codebase. 

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

**Backend Environment**:
```bash
pip install -r requirements.txt
python server.py
```

**Frontend Build**:
```bash
cd client/src && npm install && npm run build
```

## 📜 License

Apache 2.0

