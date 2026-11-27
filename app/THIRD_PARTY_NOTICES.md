# Сторонние компоненты

OpenCode 2.4.1 и официальный клиент `@opencode/client` 2.4.1 распространяются по лицензии MIT. [Текст лицензии релиза](https://github.com/anomalyco/opencode/blob/v2.4.1/LICENSE)

```text
MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## xterm.js

Терминал использует пакет `@xterm/xterm` 6.0.0 по лицензии MIT.

```text
Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Голосовой ввод

- `whisper.cpp` и GGML, включая CLI из релиза b5907, распространяются по MIT. [Лицензия whisper.cpp](https://github.com/ggml-org/whisper.cpp/blob/b5907/LICENSE)
- Готовые аддоны `@fugood/node-whisper-*` 1.2.0-rc.2 распространяются по MIT. [Исходники whisper.node](https://github.com/mybigday/whisper.node)
- Веса Whisper base и large-v3-turbo выпущены OpenAI по MIT. Используются версии GGML из репозитория сопровождающих whisper.cpp. [Лицензия OpenAI Whisper](https://github.com/openai/whisper/blob/main/LICENSE), [веса GGML](https://huggingface.co/ggerganov/whisper.cpp)
- Silero VAD 6.2.0 распространяется по MIT. Аддон запускает его через vad.cpp. [Лицензия Silero](https://github.com/snakers4/silero-vad/blob/master/LICENSE), [веса GGML](https://huggingface.co/ggml-org/whisper-vad), [поддержка VAD в аддоне](https://github.com/mybigday/whisper.node#voice-activity-detection-vad)

```text
MIT License

Copyright (c) 2023-2026 The ggml authors
Copyright (c) 2022 OpenAI
Copyright (c) 2020-present Silero Team
Copyright (c) 2025 ggml / whisper.cpp contributors
Copyright (c) 2025 Jhen-Jie Hong <developer@jhen.me>
Copyright (c) 2025 Hans Chen <hans.chen@bricks.tools>
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Каталог навыков

- Навыки Anthropic: frontend-design, webapp-testing, pdf, docx, xlsx, pptx, mcp-builder и skill-creator. В каждом каталоге сохранён исходный текст Apache 2.0. [Anthropic Skills](https://github.com/anthropics/skills/tree/e4bb5d960d87126ff3b3a8af1a104b7db67560ba/skills)
- Навыки Superpowers: test-driven-development, systematic-debugging, verification-before-completion, brainstorming и writing-plans. Copyright (c) 2025 Jesse Vincent. Текст MIT прилагается к каждому навыку. [Лицензия Superpowers](https://github.com/obra/superpowers/blob/22f0b463e7a5e579904dd6211a520321035526f7/LICENSE)
