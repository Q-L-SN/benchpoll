# Official topics — revised 2026-11-12

This catalogue follows the owner's final ordered list and replaces the earlier
23-topic proposal. English names and summaries describe the intended scope;
the owner's bracketed explanations are not displayed as copy.

| Public ID | Requested topic | English name | One-sentence summary |
| --- | --- | --- | --- |
| 1 | 智能 | Intelligence | Reason, learn and solve a broad range of intellectual tasks. |
| 2 | 智能体 | Agents | Plan and carry out tasks independently from start to finish. |
| 3 | 编码 | Coding | Build, debug and improve software across languages and interfaces. |
| 4 | ASI | ASI | Measure progress toward intelligence beyond the best human capabilities. |
| 5 | 职业工作 | Professional Work | Complete practical workplace tasks with documents, spreadsheets and business tools. |
| 6 | 学术研究 | Academic Research | Develop ideas, analyze evidence and solve problems across academic disciplines. |
| 7 | 自然语言 | Natural Language | Understand, translate and organize language for clear communication. |
| 8 | RSI | RSI | Develop and train better AI models through repeated cycles of self-improvement. |
| 9 | 生成图片 | Image Generation | Create images that match an idea, instruction or visual reference. |
| 10 | 制作视频 | Video Generation | Create coherent videos from instructions and visual references. |
| 11 | 网络安全 | Cybersecurity | Find vulnerabilities, analyze attacks and reason about cryptographic systems. |
| 12 | 医疗 | Medicine | Support clinical diagnosis, treatment decisions and everyday health questions. |
| 13 | 知识检索 | Knowledge Retrieval | Recall knowledge and find useful information for questions and research. |
| 14 | 工程设计 | Engineering Design | Design and refine practical systems, structures and components. |
| 15 | 多模态理解 | Multimodal Understanding | Interpret images, video, audio and the relationships between them. |
| 16 | GUI操作 | GUI Operation | Use software and websites through their graphical interfaces. |
| 17 | 操作机器人 | Robotics | Perceive the physical world and act to complete real-world tasks. |
| 18 | 写作 | Creative Writing | Create compelling stories, vivid prose and original ideas. |
| 19 | 经营管理 | Business Management | Run organizations, allocate resources and adapt business strategies. |
| 20 | 法律 | Law | Interpret legal texts and reason through legal questions. |
| 21 | 金融 | Finance | Analyze financial information, value assets and assess risk. |
| 22 | 3D生成 | 3D Generation | Create three-dimensional objects, geometry and scenes. |
| 23 | 长上下文 | Long Context | Recall details and reason across long documents and extended conversations. |
| 24 | 前瞻智慧 | Foresight | Anticipate future outcomes and explore how different scenarios could unfold. |
| 25 | 低幻觉 | Factual Accuracy | Give accurate answers with claims that hold up to verification. |
| 26 | 概率决策 | Probabilistic Decision-Making | Make timely choices, classifications and ratings using calibrated probabilities. |

Only four topics have scenes:

- Coding: General, Frontend, Python, JavaScript, TypeScript, Java, C, C++, C#, Go, Rust, PHP.
- Natural Language: General, English, Chinese, Japanese, Korean, Spanish, French, German, Arabic.
- Image Generation: General, Single Reference Image, Multiple Reference Images.
- Video Generation: General, With Reference Video, With Reference Image.

General is the default in all four. Existing scene identities are retained;
fresh initialization numbers scenes from 1 in the order above. AGI becomes ASI,
and Vector Graphics is retired from the official catalogue.

Public topic numbers follow the table. Reconciliation keeps internal identities,
weights, discussions, favorites and private URL tokens, so a renamed topic's
existing data remains attached to it. There are no aliases for old numeric URLs.
Popular still sorts by favorite activity; catalogue numbering does not override it.

Use the [explicit topic platform migration](topic-platform-20261112.md) to apply
this catalogue. It is never applied at application startup.

Verification: 15 focused unit/route checks and two disposable MySQL 8.4 integration
cases passed, including initialization, reconciliation, ID swaps, rollback,
repeat application, saved weights, discussion/favorite ownership, private aliases
and subsequent ID allocation. Both asset builds and focused ESLint passed.
Built-page Chromium desktop and WebKit mobile previews verified all 26 names,
summaries and numeric links, scene search and the four scene dialogs.

The catalogue update is prepared in source. No production database or deployment
was available from this cloud environment during this change.
