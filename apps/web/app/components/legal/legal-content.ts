import type { Locale } from "../../i18n/messages";

export type LegalKind = "terms" | "privacy";

export interface LegalSection {
  id: string;
  title: string;
  paragraphs: string[];
  bullets?: string[];
}

export interface LegalDocumentCopy {
  eyebrow: string;
  title: string;
  metaDescription: string;
  introduction: string;
  effectiveLabel: string;
  effectiveDate: string;
  tableOfContents: string;
  sections: LegalSection[];
  relatedLabel: string;
  relatedHref: "/terms" | "/privacy";
  relatedTitle: string;
  backToTop: string;
}

const effectiveDate = "2026-07-16";

const documents: Record<Locale, Record<LegalKind, LegalDocumentCopy>> = {
  "zh-Hans": {
    terms: {
      eyebrow: "法律信息 · 服务规则",
      title: "Spott 服务条款",
      metaDescription: "了解使用 Spott、主办或参加活动时适用的账号、报名、费用、安全、内容与争议处理规则。",
      introduction: "本条款说明你在发现、主办和参加活动，以及使用群组、积分、签到与安全功能时与 Spott 之间的权利和责任。请在创建账号或报名活动前完整阅读。",
      effectiveLabel: "生效日期",
      effectiveDate,
      tableOfContents: "本页目录",
      relatedLabel: "同时建议阅读",
      relatedHref: "/privacy",
      relatedTitle: "Spott 隐私政策",
      backToTop: "返回页首",
      sections: [
        {
          id: "scope-and-account",
          title: "适用范围与账号",
          paragraphs: [
            "当你访问或使用 Spott，即表示你同意本条款以及活动页面中明确展示的规则。若你代表组织使用 Spott，你确认自己有权代表该组织接受这些条款。",
            "你应提供准确资料、妥善保管登录凭证，并对账号下发生的操作负责。账号不得出售、出租或在未经授权的情况下转让；发现异常登录时应立即通过产品内支持渠道联系我们。",
          ],
        },
        {
          id: "hosting-and-participation",
          title: "主办与参加活动",
          paragraphs: [
            "主办方应确保活动标题、时间、地点、费用、资格、风险与取消规则准确且及时更新，并获得举办活动、使用场地和发布内容所需的授权。",
            "参加者应遵守活动规则、主办方的合理现场指示和适用法律，尊重其他成员，并仅为实际同行者提交报名信息。报名确认、候补、待审核、取消与签到状态以 Spott 服务器记录为准。",
          ],
        },
        {
          id: "registration-and-fees",
          title: "报名、候补、费用与积分",
          paragraphs: [
            "报名可能自动确认、需要主办方审核，或在满员时进入候补。候补名额的接受期限、报名截止时间及可执行操作以活动详情和你的行程页显示为准。",
            "Spott 积分与线下活动费相互独立。若活动页面说明费用由主办方在 Spott 外收取，主办方负责收款、凭证、税务与退款；参加者应在报名决定前核对收款方、方式、截止时间和退款规则。法定消费者权利不受本条款限制。",
          ],
        },
        {
          id: "changes-and-cancellations",
          title: "重要变更与取消",
          paragraphs: [
            "时间、地点、费用、资格或安全条件发生重要变化时，Spott 可要求参加者重新确认。主办方应尽快发布变化，不得用私信替代应在活动页面公开的重要信息。",
            "活动或报名取消后的名额、积分与退款处理以当时展示的规则、服务器状态和适用法律为准。已经开始、结束或因安全原因冻结的活动可能不再允许普通取消操作。",
          ],
        },
        {
          id: "conduct-and-safety",
          title: "行为、安全与举报",
          paragraphs: [
            "不得利用 Spott 实施骚扰、仇恨、歧视、欺诈、跟踪、冒充、垃圾信息、非法交易，或组织、鼓励可能造成人身伤害的活动。不得公开他人的精确地址、联系方式或安全证据。",
            "你可以通过安全中心私密举报。为保护成员或调查事件，Spott 可限制内容可见性、暂停报名、保全证据、联系相关方或依法配合主管机关；紧急危险请先联系当地紧急服务。",
          ],
        },
        {
          id: "content-and-rights",
          title: "内容与知识产权",
          paragraphs: [
            "你保留对自己内容的权利，并确认拥有发布该内容所需的授权。为托管、展示、翻译、审核和分发你选择公开或共享的内容，你授予 Spott 一项全球、非独占、免许可费且仅限提供和改进服务所需范围的许可；删除内容后，该许可在备份、安全记录和法律保留所需范围外终止。",
            "Spott 的品牌、界面、软件和非用户内容受知识产权法律保护。除法律允许或我们书面授权外，不得复制、抓取、反向工程或使用自动化方式干扰服务。",
          ],
        },
        {
          id: "restriction-and-ending",
          title: "限制、暂停与终止",
          paragraphs: [
            "发生安全风险、严重或重复违规、欺诈、未授权访问、法律要求或服务完整性风险时，Spott 可按风险限制账号、活动、群组或功能，并在适当情况下提供申诉渠道。",
            "你可以停止使用服务并在设置中申请删除账号。为履行法律义务、处理争议、保护安全或防止滥用，部分交易、安全与审计记录可能在必要期限内继续受限保存。",
          ],
        },
        {
          id: "disclaimers-and-law",
          title: "责任边界与适用法律",
          paragraphs: [
            "多数活动由用户独立主办。除非活动页面另有明确说明，Spott 不是线下活动、场地、交通或主办方外部收费的合同当事人，也不能保证每位成员、活动或第三方信息始终准确或无风险。",
            "本条款不排除或限制法律上不得排除的责任。对其他损失，Spott 的责任仅在适用法律允许的范围内受到限制。本条款适用日本法律；除强制性法律另有规定外，以东京地方裁判所为第一审专属管辖法院。",
          ],
        },
        {
          id: "updates-and-contact",
          title: "条款更新与联系",
          paragraphs: [
            "我们可能为新增功能、风险控制或法律变化更新条款。重大变化会在生效前通过产品内通知或与你账号关联的渠道说明；继续使用即表示你接受生效后的版本。",
            "如对本条款、账号限制或活动规则有疑问，请通过 Spott 设置中的支持入口或安全中心提交请求，以便完成身份核验并保留处理记录。",
          ],
        },
      ],
    },
    privacy: {
      eyebrow: "法律信息 · APPI",
      title: "Spott 隐私政策",
      metaDescription: "了解 Spott 如何收集、使用、共享、保护和保存账号、报名、位置、安全与设备信息，以及你可以行使的权利。",
      introduction: "本政策依据日本个人信息保护法（APPI）说明 Spott 在提供活动、群组、报名、签到和安全功能时如何处理个人信息，以及你如何控制自己的资料。",
      effectiveLabel: "生效日期",
      effectiveDate,
      tableOfContents: "本页目录",
      relatedLabel: "同时建议阅读",
      relatedHref: "/terms",
      relatedTitle: "Spott 服务条款",
      backToTop: "返回页首",
      sections: [
        {
          id: "controller-and-scope",
          title: "处理主体与适用范围",
          paragraphs: [
            "本政策适用于 Spott Web、iOS 应用及其直接支持的服务。Spott 服务运营方负责决定本政策所述个人信息的处理目的和方式。",
            "如需提出隐私请求，请使用账号设置中的支持入口或安全中心。我们会记录请求、核验身份，并在适用法律规定的期限内答复。",
          ],
        },
        {
          id: "data-we-collect",
          title: "我们收集的信息",
          paragraphs: ["收集范围取决于你使用的功能，主要包括："],
          bullets: [
            "账号与验证信息，例如姓名、邮箱、手机号、登录提供方、语言与安全状态；",
            "个人主页、活动、群组、评论、媒体以及你主动提交的其他内容；",
            "报名人数、问题回答、参加者备注、候补、签到、反馈与取消记录；",
            "公开区域、经授权后显示的精确集合点，以及你选择提供的设备位置；",
            "积分流水、活动费用说明、设备标识、会话、安全日志、崩溃与性能信息；",
            "举报陈述、证据、封禁关系和处理安全案件所需的通信记录。",
          ],
        },
        {
          id: "purposes",
          title: "使用目的",
          paragraphs: [
            "我们使用信息来创建和保护账号、展示与推荐活动、同步 Web 与 iOS 状态、处理报名和候补、支持签到与通知、运行群组、管理积分、提供客服，以及维护服务稳定性。",
            "我们还会用必要信息预防欺诈和滥用、调查安全事件、执行规则、履行法律义务并改进产品。非必要分析会遵循你的同意设置；我们不会把安全证据或精确地址用于广告画像。",
          ],
        },
        {
          id: "sharing",
          title: "共享与第三方提供",
          paragraphs: [
            "主办方只会收到管理活动所必需的报名信息；精确集合点只向符合活动可见性规则的已确认或已签到参加者提供。公开资料与公开内容会按你的设置向其他用户显示。",
            "我们可能向受合同约束的云托管、通信、地图、分析、客服和安全供应商提供完成服务所需的最少信息，也可能在取得同意、完成企业重组，或法律、安全和权利保护确有必要时披露。Spott 不出售个人信息，也不向数据经纪商提供个人信息。",
          ],
        },
        {
          id: "cross-border",
          title: "境外处理",
          paragraphs: [
            "部分服务供应商可能在日本境外处理信息。我们会根据 APPI 评估接收方所在地区、合同与安全措施，并采用适当保障；依法需要时会提供相关信息并取得同意。",
          ],
        },
        {
          id: "retention-and-security",
          title: "保存期限与安全措施",
          paragraphs: [
            "我们仅在实现上述目的、维持账号、履行合同与法律义务、处理争议或保护成员安全所需期间保存信息。不同记录的期限会因活动状态、财务要求、安全案件和备份周期而不同。",
            "我们使用分级访问、传输与存储保护、审计记录、会话撤销和最小权限等措施。手机号、精确地址与安全证据不得进入公开缓存；退出登录、权限撤销或内容下架后，客户端会清理相应敏感数据。任何系统都无法保证绝对安全。",
          ],
        },
        {
          id: "your-rights",
          title: "你的选择与权利",
          paragraphs: [
            "你可以在设置中更正资料、调整语言和通知、管理分析同意，并在可用时导出或删除账号数据。根据 APPI，你还可以请求披露、订正、追加、删除、停止利用、停止向第三方提供，以及披露符合条件的第三方提供记录。",
            "为保护账号和他人隐私，我们会核验请求者身份。法律允许的例外、他人权利、安全调查或必须保存的记录可能限制请求范围；如无法全部满足，我们会说明理由。",
          ],
        },
        {
          id: "cookies-and-devices",
          title: "Cookie、设备存储与分析",
          paragraphs: [
            "我们使用登录、语言、安全和同步所必需的 Cookie 或设备存储。离线缓存仅保存允许公开缓存的资源，不应保存账号令牌、精确地址、报名答案或安全证据。",
            "经你同意后，我们可能收集经过限制的产品事件来了解功能是否正常。你可以在设置中撤回非必要分析同意；撤回不影响此前合法进行的处理。",
          ],
        },
        {
          id: "minors-and-safety",
          title: "未成年人",
          paragraphs: [
            "涉及未成年人的活动必须明确标注并遵守适用法律、监护要求和更严格的安全规则。若我们发现未经适当授权处理了未成年人的信息，会采取限制、删除或联系监护人等合理措施。",
          ],
        },
        {
          id: "updates-and-contact",
          title: "政策更新与联系",
          paragraphs: [
            "我们可能因功能、供应商或法律变化更新本政策。重大变化会在生效前以清晰方式通知，并在本页保留新的生效日期。",
            "隐私、数据权利或安全事件相关问题，请通过 Spott 设置中的支持入口或安全中心提交。若存在即时人身危险，请先联系当地紧急服务。",
          ],
        },
      ],
    },
  },
  ja: {
    terms: {
      eyebrow: "法的情報・サービスルール",
      title: "Spott 利用規約",
      metaDescription: "Spottでイベントを主催・参加する際のアカウント、申込、料金、安全、コンテンツ、紛争解決のルールをご確認ください。",
      introduction: "本規約は、イベントの検索・主催・参加、グループ、ポイント、チェックイン、安全機能を利用する際の、利用者と Spott の権利および責任を定めるものです。",
      effectiveLabel: "施行日",
      effectiveDate,
      tableOfContents: "目次",
      relatedLabel: "あわせてご確認ください",
      relatedHref: "/privacy",
      relatedTitle: "Spott プライバシーポリシー",
      backToTop: "ページ上部へ",
      sections: [
        {
          id: "scope-and-account",
          title: "適用範囲とアカウント",
          paragraphs: [
            "Spott にアクセスし、または利用することで、本規約およびイベントページに明示されたルールに同意したものとみなされます。組織を代表して利用する場合、その組織を本規約に拘束する権限があることを表明します。",
            "正確な情報を登録し、認証情報を安全に管理してください。アカウントの販売、貸与、無断譲渡は禁止です。不審なログインを発見した場合は、直ちにアプリ内サポートへご連絡ください。",
          ],
        },
        {
          id: "hosting-and-participation",
          title: "主催者と参加者の責任",
          paragraphs: [
            "主催者は、タイトル、日時、場所、料金、参加条件、リスク、キャンセル条件を正確かつ最新に保ち、会場利用、開催、コンテンツ掲載に必要な権限を取得する必要があります。",
            "参加者は、イベントルール、主催者の合理的な現場案内および法令を守り、他のメンバーを尊重してください。申込確定、承認待ち、キャンセル待ち、取消し、チェックインの状態は Spott のサーバー記録を基準とします。",
          ],
        },
        {
          id: "registration-and-fees",
          title: "申込、キャンセル待ち、料金、ポイント",
          paragraphs: [
            "申込は自動確定、主催者承認制、または満席時のキャンセル待ちとなる場合があります。枠の承諾期限、申込期限、実行可能な操作はイベント詳細と参加予定画面の表示に従います。",
            "Spott ポイントと会場等で支払うイベント料金は別です。Spott 外で主催者が料金を回収する場合、回収、領収、税務、返金は主催者の責任となります。申込前に回収者、方法、期限、返金条件をご確認ください。法令上の消費者の権利は制限されません。",
          ],
        },
        {
          id: "changes-and-cancellations",
          title: "重要な変更とキャンセル",
          paragraphs: [
            "日時、場所、料金、参加条件または安全条件に重要な変更がある場合、Spott は参加者に再確認を求めることがあります。主催者は速やかに変更を公開し、重要事項を個別メッセージだけで済ませてはなりません。",
            "イベントまたは申込の取消し後の枠、ポイント、返金は、その時点で表示される規則、サーバー上の状態および適用法令に従います。開始済み、終了済み、安全上凍結されたイベントでは通常の取消操作ができない場合があります。",
          ],
        },
        {
          id: "conduct-and-safety",
          title: "行動、安全、通報",
          paragraphs: [
            "嫌がらせ、差別、ヘイト、詐欺、つきまとい、なりすまし、スパム、違法取引、身体に危険を及ぼす活動の企画・助長は禁止します。他人の正確な住所、連絡先、安全上の証拠を公開してはなりません。",
            "安全センターから非公開で通報できます。メンバー保護や調査のため、Spott は表示制限、申込停止、証拠保全、関係者への連絡、法令に基づく当局対応を行うことがあります。緊急時は先に地域の緊急通報先へ連絡してください。",
          ],
        },
        {
          id: "content-and-rights",
          title: "コンテンツと知的財産",
          paragraphs: [
            "投稿内容の権利は利用者に残ります。利用者は投稿に必要な権限を有することを保証し、サービス提供に必要な範囲で、公開・共有を選択した内容をホスト、表示、翻訳、審査、配信するための世界的、非独占的、無償のライセンスを Spott に付与します。削除後は、バックアップ、安全記録、法的保存に必要な範囲を除き終了します。",
            "Spott のブランド、画面、ソフトウェアおよび利用者投稿以外のコンテンツは知的財産法で保護されています。法令または書面による許可がない限り、複製、スクレイピング、リバースエンジニアリング、サービスを妨げる自動処理を禁止します。",
          ],
        },
        {
          id: "restriction-and-ending",
          title: "制限、停止、終了",
          paragraphs: [
            "安全上の危険、重大または反復的な違反、詐欺、不正アクセス、法的要請、サービスの完全性への危険がある場合、Spott はリスクに応じてアカウント、イベント、グループまたは機能を制限し、適切な場合は異議申立ての手段を提供します。",
            "設定からアカウント削除を申請できます。法的義務、紛争、安全保護、不正防止に必要な取引・安全・監査記録は、必要な期間に限りアクセスを制限して保持する場合があります。",
          ],
        },
        {
          id: "disclaimers-and-law",
          title: "責任範囲と準拠法",
          paragraphs: [
            "多くのイベントは利用者が独立して主催します。イベントページに明記されない限り、Spott は対面イベント、会場、移動、主催者による外部決済の契約当事者ではなく、すべてのメンバー、イベント、第三者情報が常に正確で無危険であることを保証できません。",
            "法令上排除できない責任は本規約によって排除・制限されません。その他の損害については適用法令が許す範囲で責任を限定します。本規約は日本法に準拠し、強行法規に別段の定めがない限り、東京地方裁判所を第一審の専属的合意管轄裁判所とします。",
          ],
        },
        {
          id: "updates-and-contact",
          title: "規約の変更とお問い合わせ",
          paragraphs: [
            "新機能、リスク対応、法令変更に応じて本規約を更新することがあります。重要な変更は施行前にアプリ内通知その他アカウントに関連する方法でお知らせします。施行後も利用を継続する場合、更新後の規約に同意したものとみなされます。",
            "本規約、アカウント制限、イベントルールに関するお問い合わせは、Spott の設定画面にあるサポート窓口または安全センターから送信してください。本人確認と対応履歴の保全を行います。",
          ],
        },
      ],
    },
    privacy: {
      eyebrow: "法的情報・個人情報保護法",
      title: "プライバシーポリシー",
      metaDescription: "Spott がアカウント、申込、位置、安全、端末情報をどのように取得、利用、共有、保護、保存するかと、利用者の権利をご案内します。",
      introduction: "本ポリシーは、個人情報の保護に関する法律（個人情報保護法）に基づき、Spott がイベント、グループ、申込、チェックイン、安全機能を提供する際の個人情報の取扱いと、利用者の選択肢を説明します。",
      effectiveLabel: "施行日",
      effectiveDate,
      tableOfContents: "目次",
      relatedLabel: "あわせてご確認ください",
      relatedHref: "/terms",
      relatedTitle: "Spott 利用規約",
      backToTop: "ページ上部へ",
      sections: [
        {
          id: "controller-and-scope",
          title: "取扱主体と適用範囲",
          paragraphs: [
            "本ポリシーは Spott の Web、iOS アプリおよび直接提供するサポートに適用されます。Spott のサービス運営者が、ここに記載する個人情報の利用目的と取扱方法を決定します。",
            "個人情報に関する請求は、アカウント設定のサポート窓口または安全センターから行えます。請求内容を記録し、本人確認のうえ、法令で定められた期間内に回答します。",
          ],
        },
        {
          id: "data-we-collect",
          title: "取得する情報",
          paragraphs: ["利用する機能に応じ、主に次の情報を取得します。"],
          bullets: [
            "氏名、メールアドレス、電話番号、ログイン事業者、言語、安全状態などのアカウント・認証情報",
            "プロフィール、イベント、グループ、コメント、メディアなど利用者が投稿する内容",
            "参加人数、申込質問への回答、参加者メモ、キャンセル待ち、チェックイン、フィードバック、取消しの記録",
            "公開エリア、権限取得後に表示される正確な集合場所、利用者が選択して提供する端末位置",
            "ポイント履歴、料金案内、端末識別子、セッション、安全ログ、クラッシュ・性能情報",
            "通報内容、証拠、ブロック関係、安全案件の対応に必要な通信記録",
          ],
        },
        {
          id: "purposes",
          title: "利用目的",
          paragraphs: [
            "アカウントの作成・保護、イベントの表示・推薦、Web と iOS の同期、申込・キャンセル待ち、チェックイン・通知、グループ、ポイント、サポート、サービス安定運用のために利用します。",
            "また、不正・濫用の防止、安全案件の調査、ルールの執行、法的義務の履行、製品改善にも必要な情報を利用します。任意の分析は同意設定に従い、安全上の証拠や正確な住所を広告プロファイルに使用しません。",
          ],
        },
        {
          id: "sharing",
          title: "共有と第三者提供",
          paragraphs: [
            "主催者にはイベント運営に必要な申込情報のみを共有します。正確な集合場所は、イベントの表示ルールを満たす参加確定者またはチェックイン済みの参加者に限り提供します。公開プロフィールと公開投稿は設定に従って他の利用者に表示されます。",
            "クラウド、通信、地図、分析、サポート、安全対策の委託先には、契約に基づき必要最小限の情報を提供する場合があります。また、同意がある場合、組織再編、法令、安全、権利保護に必要な場合に開示することがあります。個人情報を販売したり、データブローカーへ提供したりしません。",
          ],
        },
        {
          id: "cross-border",
          title: "外国での取扱い",
          paragraphs: [
            "一部の委託先は日本国外で情報を取り扱う場合があります。個人情報保護法に従い、所在国・地域、契約、安全管理措置を確認して適切な保護を講じ、法令上必要な場合は情報提供と同意取得を行います。",
          ],
        },
        {
          id: "retention-and-security",
          title: "保存期間と安全管理措置",
          paragraphs: [
            "利用目的、アカウント維持、契約・法的義務、紛争、安全保護に必要な期間に限って保存します。保存期間はイベント状態、会計要件、安全案件、バックアップ周期により異なります。",
            "アクセス区分、通信・保存時の保護、監査記録、セッション失効、最小権限などを用います。電話番号、正確な住所、安全上の証拠は公開キャッシュに保存せず、ログアウト、権限取消し、コンテンツ非公開時には端末上の該当データを消去します。ただし、絶対的な安全を保証するものではありません。",
          ],
        },
        {
          id: "your-rights",
          title: "選択肢と権利",
          paragraphs: [
            "設定からプロフィール、言語、通知、分析同意を変更し、利用可能な場合はデータのエクスポートやアカウント削除を行えます。個人情報保護法に基づき、開示、訂正、追加、削除、利用停止、第三者提供停止、対象となる第三者提供記録の開示を請求できます。",
            "アカウントと他者のプライバシー保護のため本人確認を行います。法令上の例外、他者の権利、安全調査、保存義務により請求範囲を制限する場合は、その理由を説明します。",
          ],
        },
        {
          id: "cookies-and-devices",
          title: "Cookie、端末保存、分析",
          paragraphs: [
            "ログイン、言語、安全、同期に必要な Cookie または端末保存領域を使用します。オフラインキャッシュは公開キャッシュが許可された資源に限り、認証トークン、正確な住所、申込回答、安全証拠を保存しません。",
            "同意がある場合、機能の動作確認に限定した製品イベントを取得することがあります。設定から任意分析への同意を撤回できます。撤回前の適法な取扱いには影響しません。",
          ],
        },
        {
          id: "minors-and-safety",
          title: "未成年者",
          paragraphs: [
            "未成年者が関わるイベントは明示し、法令、保護者の同意・監督要件、より厳格な安全ルールに従う必要があります。適切な権限なく未成年者の情報を取得したことが判明した場合、制限、削除、保護者への連絡など合理的な措置を講じます。",
          ],
        },
        {
          id: "updates-and-contact",
          title: "変更とお問い合わせ",
          paragraphs: [
            "機能、委託先、法令の変更に応じて本ポリシーを更新することがあります。重要な変更は施行前にわかりやすく通知し、本ページに新しい施行日を表示します。",
            "個人情報、データに関する権利、安全案件については、Spott の設定にあるサポート窓口または安全センターからご連絡ください。身体への差し迫った危険がある場合は、先に地域の緊急通報先へ連絡してください。",
          ],
        },
      ],
    },
  },
  en: {
    terms: {
      eyebrow: "Legal · Service rules",
      title: "Terms of Service",
      metaDescription: "Read the account, registration, fee, safety, content, and dispute rules that apply when you host or join events on Spott.",
      introduction: "These Terms explain your rights and responsibilities when you discover, host, or join events and use Spott groups, points, check-in, and safety features.",
      effectiveLabel: "Effective",
      effectiveDate,
      tableOfContents: "On this page",
      relatedLabel: "Read this with our",
      relatedHref: "/privacy",
      relatedTitle: "Privacy Policy",
      backToTop: "Back to top",
      sections: [
        {
          id: "scope-and-account",
          title: "Scope and accounts",
          paragraphs: [
            "By accessing or using Spott, you agree to these Terms and to rules clearly shown on an event page. If you use Spott for an organization, you confirm that you are authorized to accept these Terms for it.",
            "Provide accurate information, safeguard your credentials, and take responsibility for activity under your account. You may not sell, rent, or transfer an account without authorization. Report suspected unauthorized access through in-product support promptly.",
          ],
        },
        {
          id: "hosting-and-participation",
          title: "Hosts and participants",
          paragraphs: [
            "Hosts must keep an event's title, time, place, fee, eligibility, risks, and cancellation terms accurate and current. They must have the rights and permissions needed to run the event, use the venue, and publish its content.",
            "Participants must follow event rules, reasonable on-site directions, and applicable law; respect other members; and register only real members of their party. Confirmed, pending, waitlisted, cancelled, and checked-in states are determined by Spott's server records.",
          ],
        },
        {
          id: "registration-and-fees",
          title: "Registration, waitlists, fees, and points",
          paragraphs: [
            "Registration may be automatic, require host approval, or move to a waitlist when an event is full. Offer deadlines, registration deadlines, and available actions are the ones shown on the event and itinerary at that time.",
            "Spott points are separate from offline event fees. When a page says the host collects a fee outside Spott, the host is responsible for collection, receipts, taxes, and refunds. Participants should review the collector, method, deadline, and refund policy before deciding to register. Nothing in these Terms limits mandatory consumer rights.",
          ],
        },
        {
          id: "changes-and-cancellations",
          title: "Material changes and cancellations",
          paragraphs: [
            "Spott may require participants to reconfirm after a material change to time, place, fee, eligibility, or safety conditions. Hosts must publish changes promptly and must not hide important event facts only in private messages.",
            "Capacity, points, and refund outcomes after an event or registration is cancelled follow the rules displayed at the time, authoritative server state, and applicable law. Ordinary cancellation may no longer be available after an event starts, ends, or is frozen for safety.",
          ],
        },
        {
          id: "conduct-and-safety",
          title: "Conduct, safety, and reports",
          paragraphs: [
            "Do not use Spott for harassment, hate, discrimination, fraud, stalking, impersonation, spam, illegal transactions, or activities that create unreasonable risk of physical harm. Never publish another person's exact address, contact details, or safety evidence.",
            "You can report concerns privately through the Safety Center. To protect members or investigate an incident, Spott may restrict visibility, pause registration, preserve evidence, contact relevant people, or cooperate with authorities as required by law. Contact local emergency services first when danger is immediate.",
          ],
        },
        {
          id: "content-and-rights",
          title: "Content and intellectual property",
          paragraphs: [
            "You keep ownership of your content and confirm you have the rights needed to post it. You grant Spott a worldwide, non-exclusive, royalty-free license, limited to what is needed to host, display, translate, moderate, and distribute content you choose to publish or share. After deletion, that license ends except where backups, safety records, or legal retention require otherwise.",
            "Spott's brand, interface, software, and non-user content are protected by intellectual property law. Unless law or written permission allows it, you may not copy, scrape, reverse engineer, or use automation to interfere with the service.",
          ],
        },
        {
          id: "restriction-and-ending",
          title: "Restriction, suspension, and ending use",
          paragraphs: [
            "Spott may proportionately restrict an account, event, group, or feature for safety risk, serious or repeated violations, fraud, unauthorized access, legal requirements, or threats to service integrity. We provide an appeal route when appropriate.",
            "You may stop using Spott and request account deletion in Settings. Transaction, safety, and audit records may remain access-restricted for as long as needed to meet legal duties, resolve disputes, protect people, or prevent abuse.",
          ],
        },
        {
          id: "disclaimers-and-law",
          title: "Responsibility, disclaimers, and law",
          paragraphs: [
            "Most events are hosted independently by users. Unless an event page expressly says otherwise, Spott is not a party to an in-person event, venue, travel arrangement, or external fee agreement, and cannot guarantee that every member, event, or third-party statement is always accurate or risk-free.",
            "These Terms do not exclude or limit liability that cannot legally be excluded. Other liability is limited only to the extent permitted by applicable law. Japanese law governs these Terms and, unless mandatory law requires another forum, the Tokyo District Court will have exclusive jurisdiction as the court of first instance.",
          ],
        },
        {
          id: "updates-and-contact",
          title: "Updates and contact",
          paragraphs: [
            "We may update these Terms for new features, risk controls, or legal changes. We will explain material changes before they take effect through an in-product notice or a channel associated with your account. Continued use after the effective date means you accept the updated Terms.",
            "For questions about these Terms, an account restriction, or an event rule, contact us through Support in Spott Settings or the Safety Center so we can verify identity and preserve a case record.",
          ],
        },
      ],
    },
    privacy: {
      eyebrow: "Legal · APPI",
      title: "Privacy Policy",
      metaDescription: "Learn how Spott collects, uses, shares, safeguards, and retains account, registration, location, safety, and device information, and the choices available to you.",
      introduction: "This Policy explains, under Japan's Act on the Protection of Personal Information (APPI), how Spott handles personal information while providing event, group, registration, check-in, and safety features.",
      effectiveLabel: "Effective",
      effectiveDate,
      tableOfContents: "On this page",
      relatedLabel: "Read this with our",
      relatedHref: "/terms",
      relatedTitle: "Terms of Service",
      backToTop: "Back to top",
      sections: [
        {
          id: "controller-and-scope",
          title: "Who handles information and scope",
          paragraphs: [
            "This Policy applies to Spott on the Web, the iOS app, and support directly connected to those services. The operator of the Spott service determines the purposes and means of handling the personal information described here.",
            "Submit privacy requests through Support in account Settings or the Safety Center. We record the request, verify identity, and respond within the period required by applicable law.",
          ],
        },
        {
          id: "data-we-collect",
          title: "Information we collect",
          paragraphs: ["What we collect depends on the features you use and can include:"],
          bullets: [
            "account and verification details such as name, email, phone number, sign-in provider, language, and trust status;",
            "profile, event, group, comment, media, and other content you choose to provide;",
            "party size, registration answers, attendee notes, waitlist, check-in, feedback, and cancellation history;",
            "public area, an exact meeting point disclosed after authorization, and device location you choose to share;",
            "points history, event fee information, device identifiers, sessions, security logs, crash data, and performance data; and",
            "reports, evidence, blocking relationships, and communications needed to handle a safety case.",
          ],
        },
        {
          id: "purposes",
          title: "Purposes of use",
          paragraphs: [
            "We use information to create and protect accounts; display and recommend events; synchronize Web and iOS; process registrations and waitlists; support check-in and notifications; run groups and points; provide support; and keep the service reliable.",
            "We also use necessary information to prevent fraud and abuse, investigate safety incidents, enforce rules, comply with law, and improve the product. Optional analytics follow your consent setting. We do not use safety evidence or exact addresses to build advertising profiles.",
          ],
        },
        {
          id: "sharing",
          title: "Sharing and third-party disclosure",
          paragraphs: [
            "Hosts receive only registration information needed to manage their event. Exact meeting points are disclosed only to confirmed or checked-in participants who satisfy the event's visibility rule. Public profiles and content are shown to others according to your settings.",
            "We may give the minimum necessary information to contracted providers of cloud hosting, communications, maps, analytics, support, and security. We may also disclose information with consent, in a corporate reorganization, or when necessary for law, safety, or protection of rights. Spott does not sell personal information or provide it to data brokers.",
          ],
        },
        {
          id: "cross-border",
          title: "Processing outside Japan",
          paragraphs: [
            "Some providers may handle information outside Japan. We assess the destination, contracts, and safeguards under APPI, use appropriate protections, and provide information or obtain consent when the law requires it.",
          ],
        },
        {
          id: "retention-and-security",
          title: "Retention and security",
          paragraphs: [
            "We retain information only as long as needed for the purposes above, account operation, contracts, legal duties, dispute resolution, or member safety. Periods differ by event state, financial requirements, safety cases, and backup cycles.",
            "Safeguards include tiered access, protection in transit and at rest, audit records, session revocation, and least-privilege controls. Phone numbers, exact addresses, and safety evidence must not enter public caches; clients clear relevant sensitive data after logout, permission removal, or content takedown. No system can promise absolute security.",
          ],
        },
        {
          id: "your-rights",
          title: "Your choices and rights",
          paragraphs: [
            "In Settings, you can correct profile details, change language and notifications, manage analytics consent, and, where available, export or delete account data. Under APPI, you may also request disclosure, correction, addition, deletion, cessation of use, cessation of third-party provision, and disclosure of qualifying third-party provision records.",
            "We verify identity to protect accounts and other people. Legal exceptions, another person's rights, a safety investigation, or records we must retain can limit a request. If we cannot fully comply, we will explain why.",
          ],
        },
        {
          id: "cookies-and-devices",
          title: "Cookies, device storage, and analytics",
          paragraphs: [
            "We use cookies or device storage necessary for sign-in, language, security, and synchronization. Offline caches are limited to resources approved for public caching and must not contain account tokens, exact addresses, registration answers, or safety evidence.",
            "With your consent, we may collect constrained product events to understand whether features work. You can withdraw optional analytics consent in Settings; withdrawal does not affect processing that was lawful before it.",
          ],
        },
        {
          id: "minors-and-safety",
          title: "Minors",
          paragraphs: [
            "Events involving minors must be clearly identified and follow applicable law, guardian requirements, and stricter safety rules. If we learn that a minor's information was handled without appropriate authorization, we take reasonable steps such as restricting or deleting it and contacting a guardian when appropriate.",
          ],
        },
        {
          id: "updates-and-contact",
          title: "Policy updates and contact",
          paragraphs: [
            "We may update this Policy when features, providers, or laws change. We will communicate material changes clearly before they take effect and show the new effective date here.",
            "For privacy, data-rights, or safety questions, use Support in Spott Settings or the Safety Center. If there is an immediate threat to a person, contact local emergency services first.",
          ],
        },
      ],
    },
  },
};

export function legalDocument(locale: Locale, kind: LegalKind): LegalDocumentCopy {
  return documents[locale][kind];
}
