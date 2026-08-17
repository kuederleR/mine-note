FROM node:24-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    git \
    zip \
    unzip \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /project
