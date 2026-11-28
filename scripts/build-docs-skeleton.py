import json, opencc

cc = opencc.OpenCC('s2t')

# corrections after s2t, aligned with docs/glossary-docs.md
FIX = [
    ('用戶', '使用者'), ('軟件', '軟體'), ('服務器', '伺服器'), ('信息', '資訊'),
    ('上傳', '上載'), ('鏈接', '連結'), ('默認', '預設'), ('登錄', '登入'),
    ('響應', '回應'), ('字段', '欄位'), ('算法', '演算法'), ('視頻', '影片'),
    ('界面', '介面'), ('設置', '設定'), ('菜單', '選單'), ('文檔', '文件'),
    ('帶寬', '頻寬'), ('加載', '載入'), ('搜索', '搜尋'), ('用戶端', '使用者端'),
    ('數據庫', '資料庫'), ('日誌', '日誌'),
]

def hant(text):
    out = cc.convert(text)
    for a, b in FIX:
        out = out.replace(a, b)
    out = out.replace('賬號', '帳號').replace('賬單', '帳單')
    return out

def P(*paras):
    return ''.join(f'<p>{p}</p>' for p in paras)

def H2(t):
    return f'<h2>{t}</h2>'

def UL(items):
    return '<ul>' + ''.join(f'<li>{i}</li>' for i in items) + '</ul>'

NODES = [
    {
        'slug': 'getting-started', 'parent': None, 'order': 1,
        'title': {'en': 'Getting started', 'zh-hans': '快速起步'},
        'summary': {
            'en': 'Create your Tengence account, set up a workspace, launch a search app and ingest your first data.',
            'zh-hans': '创建通智云账号、建立工作空间、创建搜索应用，并接入第一批数据。',
        },
        'body': {
            'en': P(
                'Tengence brings search, GEO, recommendation and analytics onto one data foundation. This section walks you from a new account to a working search application, and points you to the product guides once you are ready to go deeper.',
                'You do not need to configure every product first. Most teams start with Tengence Search, connect one data source, and add GEO or Recommendation after the first query results look right.'
            ) + H2('What you can build') + UL([
                '<b>Tengence Search</b> — semantic and keyword search over your own content, exposed through an API or an embeddable interface.',
                '<b>Tengence GEO</b> — measure how AI answer engines see your site, and improve what they quote.',
                '<b>Tengence Recommendation</b> — event-driven recommendations for catalogue, content and on-site modules.',
                '<b>Tengence Insight</b> — behavioural data, OneID, tags, funnels and dashboards on the same data foundation.',
            ]) + H2('Recommended path') + UL([
                'Create an account and sign in to the console.',
                'Create or join a workspace, and invite the members who will operate the products.',
                'Create a search application and choose a data source.',
                'Run the first full sync, then send a test query through the API.',
                'Review usage and quota before opening the application to production traffic.',
            ]),
            'zh-hans': P(
                '通智云把搜索、GEO、推荐与分析放在同一个数据底座上。本组文档带你从一个新账号走到一个可用的搜索应用，并告诉你接下来该读哪一本产品册。',
                '不必一上来就把所有产品都配置完。多数团队先用通智搜索接入一个数据源，等第一批查询结果符合预期，再补上 GEO 或推荐。'
            ) + H2('你可以构建什么') + UL([
                '<b>通智搜索</b>：在自己的内容上做语义搜索与关键词搜索，通过 API 或可嵌入的界面交付。',
                '<b>通智GEO</b>：衡量 AI 答案引擎如何看待你的站点，并改善它们引用你的方式。',
                '<b>通智推荐</b>：面向商品、内容与站内模块的事件驱动推荐。',
                '<b>通智睿见</b>：在同一数据底座上做行为数据、OneID、标签、漏斗与看板。',
            ]) + H2('推荐路径') + UL([
                '注册账号并登录控制台。',
                '创建工作空间或加入已有工作空间，并邀请后续要操作产品的成员。',
                '创建搜索应用，选择数据源。',
                '执行第一次全量同步，再通过 API 发一条测试查询。',
                '对外开放生产流量前，先核对用量与配额。',
            ]),
        },
    },
    {
        'slug': 'platform', 'parent': None, 'order': 2,
        'title': {'en': 'Platform and account', 'zh-hans': '平台与账号'},
        'summary': {
            'en': 'Account, workspace, members and roles, plans and usage, API keys — the shared foundation for every Tengence product.',
            'zh-hans': '账号、工作空间、成员与角色、套餐与用量、API Key，是所有通智云产品共用的基础。',
        },
        'body': {
            'en': P(
                'Every Tengence product runs inside the same account and workspace. Setting these up correctly once avoids rework later: billing, permissions and API credentials are all scoped here.',
                'Read this group before you invite a team or connect a production integration.'
            ) + H2('In this group') + UL([
                'Sign up and sign in — how accounts are created and how sessions work.',
                'Workspace and members — roles, invitations and what each role can change.',
                'Plans and usage — what each plan includes and how usage is counted.',
                'API keys — creating, rotating and scoping credentials.',
            ]),
            'zh-hans': P(
                '所有通智云产品都运行在同一个账号与工作空间里。这里配置对了，后面的计费、权限和 API 凭据都不会返工。',
                '在邀请团队或接入生产集成之前，先读完这一组。'
            ) + H2('本组内容') + UL([
                '注册与登录：账号如何创建，会话如何保持。',
                '工作空间与成员：角色、邀请，以及每个角色能改什么。',
                '套餐与用量：各套餐包含什么，用量如何计量。',
                'API Key：创建、轮换与权限范围。',
            ]),
        },
    },
    {
        'slug': 'products', 'parent': None, 'order': 3,
        'title': {'en': 'Products', 'zh-hans': '产品'},
        'summary': {
            'en': 'Product manuals for Tengence Search, GEO, Recommendation and Insight — each with setup, operation, reference and troubleshooting.',
            'zh-hans': '通智搜索、通智GEO、通智推荐、通智睿见的产品册，每本包含接入、操作、参考与故障排查。',
        },
        'body': {
            'en': P(
                'Each product manual follows the same five-part shape: a landing page that explains what the product does and who it is for, then setup, operation, reference and troubleshooting. Start at the landing page; jump to reference only when you are already integrating.',
                'The products share a data foundation, so data ingested for Search is also available to Recommendation and Insight without a second pipeline.'
            ) + H2('Manuals') + UL([
                'Tengence Search — search applications, data ingestion, relevance and query API.',
                'Tengence GEO — AI visibility diagnosis, monitoring and content optimisation.',
                'Tengence Recommendation — tracking events, recall strategies and A/B tests.',
                'Tengence Insight — behavioural data, OneID, tags, funnels and dashboards.',
            ]),
            'zh-hans': P(
                '每本产品册都是同一个五段结构：先是一页产品落地页，说明这个产品做什么、适合谁；然后是接入、操作、参考、故障排查。从落地页读起，已经在对接时再直接跳到参考。',
                '四个产品共用数据底座：为搜索接入的数据，推荐与睿见可以直接复用，不需要再建一条管道。'
            ) + H2('产品册') + UL([
                '通智搜索：搜索应用、数据接入、相关性调优与查询 API。',
                '通智GEO：AI 可见性诊断、监测与内容优化。',
                '通智推荐：埋点事件、召回策略与 A/B 实验。',
                '通智睿见：行为数据、OneID、标签、漏斗与看板。',
            ]),
        },
    },
    {
        'slug': 'integration', 'parent': None, 'order': 4,
        'title': {'en': 'Integration and API', 'zh-hans': '集成与 API'},
        'summary': {
            'en': 'Connect data and clients to Tengence: data ingestion, the push data API, MCP tools and MCP integration.',
            'zh-hans': '把数据与客户端接到通智云：数据接入、推送数据 API、MCP 工具与 MCP 集成。',
        },
        'body': {
            'en': P(
                'Integration work falls into two directions: getting your data in, and letting your tools query it. This group covers both, plus the MCP surface for AI clients.',
                'If you only need one source and one query path, read “Data ingestion” and “Push data with the API”. MCP pages are for teams wiring an AI assistant or IDE into Tengence.'
            ) + H2('In this group') + UL([
                'Data ingestion — supported source types, full and incremental sync.',
                'Push data with the API — batch and real-time writes, idempotency.',
                'MCP tools — the tool surface exposed to AI clients.',
                'MCP integration — connecting an MCP client and scoping credentials.',
            ]),
            'zh-hans': P(
                '集成工作只有两个方向：把数据送进来，让你的工具查得到。本组两边都覆盖，并补充面向 AI 客户端的 MCP 接口。',
                '如果只需要一个数据源、一条查询路径，先读“数据接入”和“用 API 推送数据”。MCP 两篇留给要把 AI 助手或 IDE 接到通智云的团队。'
            ) + H2('本组内容') + UL([
                '数据接入：支持的数据源类型、全量与增量同步。',
                '用 API 推送数据：批量与实时写入、幂等。',
                'MCP 工具参考：暴露给 AI 客户端的工具面。',
                'MCP 接入：连接 MCP 客户端并限定凭据权限。',
            ]),
        },
    },
    {
        'slug': 'solutions', 'parent': None, 'order': 5,
        'title': {'en': 'Solutions', 'zh-hans': '解决方案'},
        'summary': {
            'en': 'How teams combine Tengence products for semantic search, organic growth, ecommerce conversion and data intelligence.',
            'zh-hans': '团队如何组合通智云产品，落地语义搜索、自然流量增长、电商转化与数据智能。',
        },
        'body': {
            'en': P(
                'A solution is a combination of products, not a separate product. Each page describes the business problem, which products carry it, and the order to implement them.',
                'Use these pages when you are planning a rollout and need to decide scope, not when you are looking for an API signature.'
            ) + H2('Scenarios') + UL([
                'Semantic search — replace keyword-only site search with hybrid retrieval.',
                'Organic growth — make content discoverable to search engines and AI answers.',
                'Ecommerce conversion — recommendations and search tuned for revenue.',
                'Data intelligence — one behavioural model behind every downstream tool.',
            ]),
            'zh-hans': P(
                '解决方案是产品的组合，不是另一个产品。每页说明业务问题、由哪些产品承担，以及实施的先后顺序。',
                '这些页面用于规划上线范围；要找 API 签名请直接看产品册的参考部分。'
            ) + H2('场景') + UL([
                '语义搜索：把只靠关键词的站内搜索换成混合检索。',
                '自然流量增长：让内容同时被搜索引擎与 AI 答案发现。',
                '电商转化：围绕成交调优搜索与推荐。',
                '数据智能：用一套行为模型支撑所有下游工具。',
            ]),
        },
    },
    {
        'slug': 'concepts', 'parent': None, 'order': 6,
        'title': {'en': 'Concepts and metrics', 'zh-hans': '概念与指标'},
        'summary': {
            'en': 'Retrieval quality, impressions, CTR and other definitions shared across Tengence products and reports.',
            'zh-hans': '检索效果、曝光、CTR 等通智云产品与报表共用的定义。',
        },
        'body': {
            'en': P(
                'Definitions live here so that a number means the same thing in Search, GEO, Recommendation and Insight. When a page uses a metric without explaining it, this group is the reference.',
                'Metric definitions are written before a metric appears in any product page. Billing mechanics are out of scope: those are described on the pricing page, not in the docs.'
            ) + H2('In this group') + UL([
                'Retrieval quality — recall, relevance and how they are evaluated.',
                'Metrics — impression, PV, UV, click, CTR, conversion and conversion rate.',
            ]),
            'zh-hans': P(
                '定义集中放在这里，保证同一个数字在搜索、GEO、推荐与睿见里含义一致。产品页用到指标时，以本组为准。',
                '指标先有定义，才允许出现在产品页。计费机制不在文档里展开，统一看定价页。'
            ) + H2('本组内容') + UL([
                '检索效果：召回、相关性，以及如何评估。',
                '指标：曝光、PV、UV、点击、CTR、转化与转化率。',
            ]),
        },
    },
    {
        'slug': 'overview', 'parent': 'products', 'order': 0, 'key': 'products-overview',
        'title': {'en': 'Product overview', 'zh-hans': '产品总览'},
        'summary': {
            'en': 'One map of the four Tengence products, what each owns, and which one to start with.',
            'zh-hans': '四款通智云产品的一张地图：各自负责什么，应该从哪个开始。',
        },
        'body': {
            'en': P(
                'The four products answer different questions but read and write the same data foundation. Search serves queries, Recommendation decides what to show next, GEO measures external visibility, and Insight explains what users did.',
                'Most rollouts start with Search because it produces a visible result quickly and establishes the data pipeline the other products reuse.'
            ) + H2('Choose by problem') + UL([
                'Users cannot find the right page or product → Tengence Search.',
                'AI answers and search engines do not mention your site → Tengence GEO.',
                'Visitors do not discover relevant items → Tengence Recommendation.',
                'Teams cannot agree on what happened in the funnel → Tengence Insight.',
            ]),
            'zh-hans': P(
                '四款产品回答不同的问题，但读写同一个数据底座。搜索负责查询，推荐决定下一步展示什么，GEO 衡量外部可见性，睿见解释用户做了什么。',
                '多数项目从搜索开始：它最快产出可见结果，并顺带把其他产品要复用的数据管道建起来。'
            ) + H2('按问题选产品') + UL([
                '用户找不到正确的页面或商品：通智搜索。',
                'AI 答案与搜索引擎不提及你的站点：通智GEO。',
                '访客发现不了相关内容或商品：通智推荐。',
                '团队对漏斗里发生了什么没有共识：通智睿见。',
            ]),
        },
    },
    {
        'slug': 'tengence-search', 'parent': 'products', 'order': 1,
        'title': {'en': 'Tengence Search', 'zh-hans': '通智搜索'},
        'summary': {
            'en': 'Build semantic and keyword search over your own content, from the first data sync to production queries.',
            'zh-hans': '在自己的内容上构建语义与关键词搜索，从第一次数据同步到生产查询。',
        },
        'body': {
            'en': P(
                'Tengence Search indexes your content and serves hybrid retrieval: keyword matching for precision, vector recall for meaning, and a ranking layer that blends both. You create one search application per corpus and choose how it is exposed — API, embedded interface, or both.',
                'The manual is split into four parts. Setup gets an application running; operation covers sync, index health and relevance tuning; reference documents the query API; troubleshooting covers the failures teams actually hit.'
            ) + H2('Start here') + UL([
                'Setup — create a search application and ingest the first data source.',
                'Operate — scheduled sync, index rebuilds, relevance checks.',
                'Reference — query parameters, response fields and error codes.',
                'Troubleshooting — empty results, stale indexes, latency and quota errors.',
            ]),
            'zh-hans': P(
                '通智搜索为你的内容建索引，提供混合检索：关键词保证精确，向量召回保证语义，再由排序层融合两者。一个语料建一个搜索应用，并决定交付方式：API、嵌入式界面，或两者都要。',
                '本册分四部分：接入让应用跑起来；操作覆盖同步、索引健康与相关性调优；参考记录查询 API；故障排查只写团队真正会遇到的失败。'
            ) + H2('从这里开始') + UL([
                '接入：创建搜索应用，接入第一个数据源。',
                '操作：定时同步、重建索引、相关性检查。',
                '参考：查询参数、响应字段与错误码。',
                '故障排查：结果为空、索引过期、延迟与配额错误。',
            ]),
        },
    },
    {
        'slug': 'tengence-geo', 'parent': 'products', 'order': 2,
        'title': {'en': 'Tengence GEO', 'zh-hans': '通智GEO'},
        'summary': {
            'en': 'Diagnose and improve how AI answer engines and search engines see, quote and cite your site.',
            'zh-hans': '诊断并改善 AI 答案引擎与搜索引擎如何看待、引用你的站点。',
        },
        'body': {
            'en': P(
                'Tengence GEO starts from a diagnosis: it crawls the site, compares pages against the questions buyers actually ask, and scores how visible and quotable each page is. Monitoring then tracks the same questions over time so you can see whether changes worked.',
                'Optimisation is content work, not a metadata trick. The product tells you which page, which section and which entity is missing; the writing still happens in your CMS.'
            ) + H2('Typical flow') + UL([
                'Run a site diagnosis and read the score breakdown.',
                'Pick the pages with the highest gap between demand and visibility.',
                'Rewrite or extend those pages, then resubmit the site.',
                'Track the monitored keywords and compare before and after.',
            ]),
            'zh-hans': P(
                '通智GEO 从诊断开始：抓取站点，把页面与买家真正会问的问题对照，给出每一页的可见性与可引用性评分。监测则持续跟踪同一批问题，验证改动是否有效。',
                '优化是内容工作，不是改几个 meta 标签。产品会指出缺的是哪一页、哪一节、哪个实体；具体重写仍然在你的 CMS 里完成。'
            ) + H2('典型流程') + UL([
                '执行站点诊断，读懂评分构成。',
                '挑出需求与可见性差距最大的页面。',
                '改写或扩写这些页面，再重新提交站点。',
                '跟踪监测词，对比改动前后。',
            ]),
        },
    },
    {
        'slug': 'tengence-recommendation', 'parent': 'products', 'order': 3,
        'title': {'en': 'Tengence Recommendation', 'zh-hans': '通智推荐'},
        'summary': {
            'en': 'Event-driven recommendations for catalogue, content and on-site modules, with recall strategies and A/B tests.',
            'zh-hans': '面向商品、内容与站内模块的事件驱动推荐，包含召回策略与 A/B 实验。',
        },
        'body': {
            'en': P(
                'Recommendation consumes the behavioural events you already track and returns ranked items for a given slot. A scenario defines the slot, the recall strategies behind it and the fallback when there is no signal.',
                'Start with one high-traffic slot. Proving lift on a single module is cheaper than rebuilding every page, and the event model you establish there carries over.'
            ) + H2('What you configure') + UL([
                'Events and properties — what is tracked and how it is named.',
                'Scenarios — the slot, its recall mix and fallback rules.',
                'A/B tests — traffic split, metric and decision rule.',
            ]),
            'zh-hans': P(
                '推荐消费你已经采集的行为事件，为指定位置返回排序后的条目。一个推荐场景定义位置、背后的召回策略，以及没有信号时的兜底。',
                '从一个高流量位置开始。在单个模块上证明提升，比一次性重做所有页面便宜，而且这里建好的事件模型可以直接复用。'
            ) + H2('需要配置什么') + UL([
                '事件与属性：采集什么、如何命名。',
                '推荐场景：位置、召回组合与兜底规则。',
                'A/B 实验：流量拆分、指标与决策规则。',
            ]),
        },
    },
    {
        'slug': 'tengence-insight', 'parent': 'products', 'order': 4,
        'title': {'en': 'Tengence Insight', 'zh-hans': '通智睿见'},
        'summary': {
            'en': 'Behavioural data, OneID, tags, segments, funnels and dashboards on the shared data foundation.',
            'zh-hans': '共享数据底座上的行为数据、OneID、标签、分群、漏斗与看板。',
        },
        'body': {
            'en': P(
                'Insight turns raw events into one behavioural model: OneID resolves identities across devices and channels, tags and segments describe users, and funnels and dashboards answer “what happened”.',
                'Because it reads the same foundation as Search and Recommendation, a tracking event added once is available to every product. Billing follows analysis volume; the pricing page carries the commercial detail.'
            ) + H2('Core objects') + UL([
                'Events and properties — the raw behavioural record.',
                'OneID — identity resolution across sources.',
                'Tags and segments — reusable audience definitions.',
                'Funnels, retention and dashboards — the analysis layer.',
            ]),
            'zh-hans': P(
                '睿见把原始事件整理成一套行为模型：OneID 打通设备与渠道身份，标签与分群描述用户，漏斗与看板回答“发生了什么”。',
                '它与搜索、推荐读同一个底座，所以一条埋点采集一次，所有产品都能用。计费按分析量计算，商务细节见定价页。'
            ) + H2('核心对象') + UL([
                '事件与属性：原始行为记录。',
                'OneID：跨来源的身份打通。',
                '标签与分群：可复用的受众定义。',
                '漏斗、留存与看板：分析层。',
            ]),
        },
    },
    {
        'slug': 'overview', 'parent': 'solutions', 'order': 0, 'key': 'solutions-overview',
        'title': {'en': 'Solutions overview', 'zh-hans': '解决方案总览'},
        'summary': {
            'en': 'Four ways teams combine Tengence products, and the signals that tell you which one applies.',
            'zh-hans': '团队组合通智云产品的四种方式，以及判断该用哪一种的信号。',
        },
        'body': {
            'en': P(
                'Solutions describe outcomes, not SKUs. Each one names the business problem, the products that carry it, the data you must already have, and the sequence that produces a measurable result earliest.',
                'Read the overview first if you are scoping a programme; read a single scenario page if the problem is already clear.'
            ) + H2('The four scenarios') + UL([
                'Semantic search — users describe what they need and still find it.',
                'Organic growth — content is discovered by search engines and AI answers.',
                'Ecommerce conversion — search and recommendations move revenue, not just clicks.',
                'Data intelligence — one behavioural truth for every team.',
            ]),
            'zh-hans': P(
                '解决方案描述结果，不描述 SKU。每一页写清业务问题、由哪些产品承担、需要已经具备什么数据，以及哪条顺序能最快产出可衡量的结果。',
                '规划整体项目先读总览；问题已经明确，就直接读对应场景。'
            ) + H2('四个场景') + UL([
                '语义搜索：用户描述需求，仍然找得到。',
                '自然流量增长：内容被搜索引擎与 AI 答案发现。',
                '电商转化：搜索与推荐推动成交，而不只是点击。',
                '数据智能：所有团队共用一套行为事实。',
            ]),
        },
    },
    {
        'slug': 'setup', 'parent': 'products/tengence-search', 'order': 1, 'key': 'search-setup',
        'title': {'en': 'Setup', 'zh-hans': '接入'},
        'summary': {
            'en': 'Create a search application, connect a data source and run the first sync before sending production queries.',
            'zh-hans': '创建搜索应用、接入数据源，并在对外查询前完成第一次同步。',
        },
        'body': {
            'en': P(
                'Setup has two deliverables: an application with a working query endpoint, and an index that reflects your content. Do them in that order; a query endpoint without data looks healthy and returns nothing.',
                'You need workspace administrator rights for the first application, because the data source credential is stored at workspace scope.'
            ) + H2('Steps') + UL([
                'Create the application and note its application ID.',
                'Choose a data source: API push, scheduled crawl, or a connector.',
                'Map fields — title, body, URL, and any filterable attributes.',
                'Run a full sync and check the document count against the source.',
                'Send a test query and confirm the expected page ranks first.',
            ]) + H2('Before you continue') + UL([
                'Document count matches the source, not just “greater than zero”.',
                'A known query returns the known page in the top three results.',
                'Indexing latency is understood for your sync mode.',
            ]),
            'zh-hans': P(
                '接入要交付两件事：一个能查询的应用，以及一份反映真实内容的索引。顺序不能反——只有查询端点没有数据，看起来健康，实际什么都查不到。',
                '第一个应用需要工作空间管理员权限，因为数据源凭据保存在工作空间级别。'
            ) + H2('步骤') + UL([
                '创建应用，记下应用 ID。',
                '选择数据源：API 推送、定时抓取，或连接器。',
                '映射字段：标题、正文、URL，以及需要过滤的属性。',
                '执行全量同步，用文档数与数据源核对。',
                '发一条测试查询，确认目标页面排在第一位。',
            ]) + H2('继续之前') + UL([
                '文档数与数据源一致，而不只是“大于零”。',
                '已知查询的前三条里包含已知页面。',
                '清楚当前同步模式下的索引延迟。',
            ]),
        },
    },
    {
        'slug': 'operate', 'parent': 'products/tengence-search', 'order': 2, 'key': 'search-operate',
        'title': {'en': 'Operate', 'zh-hans': '操作'},
        'summary': {
            'en': 'Keep the index fresh: scheduled sync, rebuilds, relevance checks and the routine that catches drift early.',
            'zh-hans': '保持索引新鲜：定时同步、重建、相关性检查，以及及早发现漂移的日常动作。',
        },
        'body': {
            'en': P(
                'An index drifts quietly. The operating routine is less about fixing failures than about noticing them before users do: sync lag, dropped documents and relevance regressions all show up in numbers first.',
                'Run the checks on a fixed cadence — daily for high-traffic applications, weekly for internal ones — and record the baseline so a change is visible.'
            ) + H2('Routine') + UL([
                'Confirm the last successful sync and its lag.',
                'Compare document count with the source; investigate any drop.',
                'Replay a fixed set of ten queries and compare top-three results.',
                'Rebuild the index after a mapping or analyser change, never before.',
            ]) + H2('When relevance drops') + UL([
                'Check whether the drop follows a content change or a sync failure.',
                'Inspect recall: are the right documents retrieved at all?',
                'Then inspect ranking: retrieved but ordered wrong is a different fix.',
            ]),
            'zh-hans': P(
                '索引会悄悄漂移。日常操作的重点不是修故障，而是在用户发现之前先看到：同步延迟、文档丢失、相关性回退，都会先体现在数字上。',
                '按固定节奏检查——高流量应用每天，内部应用每周——并记录基线，改动才看得出来。'
            ) + H2('日常动作') + UL([
                '确认最近一次同步成功及其延迟。',
                '用文档数与数据源对比，下降必须追查。',
                '回放固定的十条查询，对比前三条结果。',
                '映射或分析器改动后才重建索引，不要提前重建。',
            ]) + H2('相关性下降时') + UL([
                '先判断下降是否紧跟内容变更或同步失败。',
                '查召回：正确的文档到底有没有被取回。',
                '再查排序：取回了但顺序错，是另一类修法。',
            ]),
        },
    },
    {
        'slug': 'reference', 'parent': 'products/tengence-search', 'order': 3, 'key': 'search-reference',
        'title': {'en': 'Reference', 'zh-hans': '参考'},
        'summary': {
            'en': 'Query endpoint, parameters, response fields and error codes for the Tengence Search API.',
            'zh-hans': '通智搜索 API 的查询端点、参数、响应字段与错误码。',
        },
        'body': {
            'en': P(
                'The query endpoint accepts a text query, optional filters and a page size, and returns ranked documents with the score components that produced the order. Identifiers, field names and error codes on this page are stable and are not translated.',
                'Authentication uses an API key created in the workspace; the key is sent in the request header and never in the URL.'
            ) + H2('Request') + UL([
                '<b>POST /v1/search/query</b> — body: query, filters, page, page_size.',
                '<b>query</b> — the user text, required, maximum length enforced per plan.',
                '<b>filters</b> — attribute equality and range filters declared at ingestion.',
                '<b>page_size</b> — default 10, maximum 100.',
            ]) + H2('Response') + UL([
                'items — id, title, url, snippet, score and score components.',
                'total — estimated matches, not an exact count.',
                'took_ms — server-side processing time.',
            ]) + H2('Errors') + UL([
                '401 unauthorized — missing or revoked API key.',
                '422 invalid_filter — a filter references an undeclared attribute.',
                '429 rate_limited — retry after the interval in the response header.',
            ]),
            'zh-hans': P(
                '查询端点接收文本查询、可选过滤条件与分页大小，返回排序后的文档，以及产生该顺序的评分构成。本页的标识符、字段名与错误码保持原样，不做翻译。',
                '鉴权使用工作空间里创建的 API Key；Key 放在请求头，不放在 URL 里。'
            ) + H2('请求') + UL([
                '<b>POST /v1/search/query</b>：请求体包含 query、filters、page、page_size。',
                '<b>query</b>：用户文本，必填，长度上限随套餐。',
                '<b>filters</b>：接入时声明的属性等值与范围过滤。',
                '<b>page_size</b>：默认 10，最大 100。',
            ]) + H2('响应') + UL([
                'items：id、title、url、snippet、score 与评分构成。',
                'total：预估匹配数，不是精确总数。',
                'took_ms：服务端处理耗时。',
            ]) + H2('错误码') + UL([
                '401 unauthorized：API Key 缺失或已吊销。',
                '422 invalid_filter：过滤条件引用了未声明的属性。',
                '429 rate_limited：按响应头中的间隔重试。',
            ]),
        },
    },
    {
        'slug': 'troubleshoot', 'parent': 'products/tengence-search', 'order': 4, 'key': 'search-troubleshoot',
        'title': {'en': 'Troubleshooting', 'zh-hans': '故障排查'},
        'summary': {
            'en': 'Fixes for the failures search teams actually hit: empty results, stale documents, slow queries and quota errors.',
            'zh-hans': '搜索团队真正会遇到的失败：结果为空、文档过期、查询变慢与配额报错。',
        },
        'body': {
            'en': P(
                'Most “search is broken” reports are one of four causes. Work through them in order: data present, data fresh, query valid, quota available. Each check is cheaper than the next.',
                'If a check passes, move on; do not rebuild the index as a first response, because it hides the original cause and costs a full sync window.'
            ) + H2('Empty results') + UL([
                'Confirm documents exist for the query language — a language-mismatched index returns nothing.',
                'Check the filter: an undeclared attribute returns 422, a legal but empty range returns zero.',
                'Test one exact title from the source; if it is missing, the problem is ingestion.',
            ]) + H2('Stale documents') + UL([
                'Look at last sync time and document count before touching relevance.',
                'A drop in count means deletions or failed writes, not ranking.',
            ]) + H2('Slow queries') + UL([
                'Compare took_ms with a single-term query to separate retrieval from ranking.',
                'Large page_size and wide filters are the usual causes.',
            ]) + H2('Quota and rate errors') + UL([
                '429 is a rate limit: retry with backoff.',
                'Quota exhaustion is a plan limit: check usage before changing code.',
            ]),
            'zh-hans': P(
                '多数“搜索坏了”的报告只有四种原因。按顺序排查：数据在不在、数据新不新、查询合不合法、配额还有没有。每一步都比下一步便宜。',
                '某项检查通过就继续往下，不要把重建索引当第一反应——它会掩盖原始原因，还要占用一个完整同步窗口。'
            ) + H2('结果为空') + UL([
                '确认该查询语言下有文档——语言不匹配的索引一定返回空。',
                '检查过滤条件：未声明的属性返回 422，合法但空的范围返回零条。',
                '用数据源里一个精确标题测试；如果它也查不到，问题在接入。',
            ]) + H2('文档过期') + UL([
                '先看最近同步时间与文档数，再谈相关性。',
                '文档数下降意味着删除或写入失败，不是排序问题。',
            ]) + H2('查询变慢') + UL([
                '用单词查询对比 took_ms，区分检索与排序。',
                '常见原因是过大的 page_size 与过宽的过滤条件。',
            ]) + H2('配额与速率错误') + UL([
                '429 是速率限制：退避重试。',
                '配额耗尽是套餐上限：先查用量，再改代码。',
            ]),
        },
    },
]

out = []
for n in NODES:
    key = n.get('key') or n['slug'].replace('/', '-')
    for lang in ('en', 'zh-hans', 'zh-hant'):
        src = 'zh-hans' if lang == 'zh-hant' else lang
        out.append({
            'postType': 'tengence_doc',
            'language': lang,
            'translationGroup': 'docs-' + key,
            'parent': n['parent'],
            'menuOrder': n['order'],
            'slug': n['slug'],
            'title': n['title'][src if src == 'en' else 'zh-hans'] if lang != 'zh-hant' else hant(n['title']['zh-hans']),
            'status': 'publish',
            'content': n['body'][src] if lang != 'zh-hant' else hant(n['body']['zh-hans']),
            'excerpt': (n['summary'][src] if lang != 'zh-hant' else hant(n['summary']['zh-hans'])),
            'meta': {
                '_tengence_doc_summary': n['summary'][src] if lang != 'zh-hant' else hant(n['summary']['zh-hans']),
                '_tengence_doc_translation_key': 'docs-' + key,
                '_tengence_doc_noindex': False,
                '_tengence_doc_owner': 'docs',
                '_tengence_doc_reviewed_at': '2026-11-28',
            },
        })

with open('packages/geo-cli/data/tengence-docs-skeleton.json', 'w') as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
print(len(out), 'payloads')
