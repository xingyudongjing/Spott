import { PreviewModeLink as Link } from '../components/PreviewModeLink';
import { LoginForm } from './LoginForm';
import { serverLocale } from '../i18n/server';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const [{ returnTo }, locale] = await Promise.all([searchParams, serverLocale()]);
  const copy =
    locale === 'ja'
      ? { hero: '街は、出会いを\n用意してくれない。', heroNote: 'でも、ひとつのイベントなら。', title: 'Spott にログイン', body: 'まずは自由に探して、参加したくなったときにログイン。iOS と Web は同じアカウントで同期します。' }
      : locale === 'en'
        ? { hero: 'A city won’t arrange\nthe people you meet.', heroNote: 'A real event can.', title: 'Log in to Spott', body: 'Browse freely and log in when you are ready to join. The same account stays in sync across Web and iOS.' }
        : { hero: '城市不会替你\n安排一次相遇。', heroNote: '但一个真实的活动可以。', title: '登录 Spott', body: '先浏览，等你真的想参加时再登录。登录状态会和 iOS 端的同一账号同步。' };
  return (
    <main className="auth-page">
      <div className="auth-visual">
        <div className="auth-visual-copy">
          <span>SPOTT / TOKYO AFTERGLOW</span>
          <h1>{copy.hero.split('\n').map((line) => <span key={line}>{line}<br /></span>)}</h1>
          <p>{copy.heroNote}</p>
        </div>
      </div>
      <div className="auth-panel">
        <Link className="wordmark" href="/discover">
          SPOTT
        </Link>
        <div className="auth-copy">
          <span className="section-number">WELCOME</span>
          <h2>{copy.title}</h2>
          <p>{copy.body}</p>
        </div>
        <LoginForm returnTo={returnTo} />
      </div>
    </main>
  );
}
