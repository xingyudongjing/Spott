import Link from "next/link";
export default function NotFound(){return <main className="flow-page"><div className="empty-state"><span className="spotlight-empty"/><span className="section-number">404 / LOST SPOT</span><h1>这里没有活动。</h1><p>可能已取消、下架或链接发生了变化。</p><Link className="primary-action compact" href="/discover">回到发现</Link></div></main>}
