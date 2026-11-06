window.__ModuleLoader__.load({
  id: 'dsh-session-done-notifier',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'session-done-notifier';
    const ENDPOINT = '/session-done-notifier/settings';
    const ACTIVATE_ENDPOINT = '/session-done-notifier/activate';
    const PENDING_ENDPOINT = '/session-done-notifier/pending';
    const HEADER = { 'x-session-done-notifier': '1' };
    let activationBusy = false;

    // Two compact controls in the composer tool row. `is-on` uses the brand
    // accent, `is-off` falls back to the idle state token, so the pair reads
    // as toggles without a separate menu.
    const CSS = `
.g1-sdn-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 24px;
  height: 24px;
  margin: 0 1px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease, opacity 120ms ease;
  appearance: none;
}
.g1-sdn-toggle:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
  color: var(--dsw-alias-label-primary);
}
.g1-sdn-toggle:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.g1-sdn-toggle.is-on {
  color: var(--dsw-alias-brand-primary);
}
.g1-sdn-toggle.is-off {
  color: var(--dsw-alias-state-idle-primary, var(--dsw-alias-label-secondary));
  opacity: 0.78;
}
.g1-sdn-toggle:disabled {
  cursor: default;
  opacity: 0.45;
}
`;

    const DICT = {
      zh: {
        popup: '会话完成弹窗',
        popupOn: '会话完成弹窗：开（点击关闭）',
        popupOff: '会话完成弹窗：关（点击开启）',
        sound: '提示音',
        soundOn: '提示音：开（点击关闭）',
        soundOff: '提示音：关（点击开启）',
      },
      en: {
        popup: 'Session completion popup',
        popupOn: 'Session completion popup: on (click to turn off)',
        popupOff: 'Session completion popup: off (click to turn on)',
        sound: 'Notification sound',
        soundOn: 'Notification sound: on (click to turn off)',
        soundOff: 'Notification sound: off (click to turn on)',
      },
    };

    const ICONS = {
      bell: [
        'M12 3.6a5.4 5.4 0 0 0-5.4 5.4v3.3l-1.5 2.6c-.3.6.1 1.3.8 1.3h12.2c.7 0 1.1-.7.8-1.3l-1.5-2.6V9A5.4 5.4 0 0 0 12 3.6z',
        'M9.9 19.1a2.15 2.15 0 0 0 4.2 0',
      ],
      bellOff: [
        'M12 3.6a5.4 5.4 0 0 0-5.4 5.4v3.3l-1.5 2.6c-.3.6.1 1.3.8 1.3h12.2c.7 0 1.1-.7.8-1.3l-1.5-2.6V9A5.4 5.4 0 0 0 12 3.6z',
        'M9.9 19.1a2.15 2.15 0 0 0 4.2 0',
        'M4 4l16 16',
      ],
      speaker: [
        'M4.8 9.6h2.8L11.6 6.3v11.4l-3.9-3.3H4.8z',
        'M15.1 8.9a4.4 4.4 0 0 1 0 6.2',
        'M17.6 6.4a8 8 0 0 1 0 11.2',
      ],
      speakerOff: [
        'M4.8 9.6h2.8L11.6 6.3v11.4l-3.9-3.3H4.8z',
        'M15.1 9.6l4.6 4.8',
        'M19.7 9.6l-4.6 4.8',
      ],
    };

    /** Active locale id, tolerant of both a Locale object and a bare id string. */
    function langOf(snapshot) {
      const active = snapshot?.active;
      const id = typeof active === 'string' ? active : active?.id ?? active?.tag ?? 'en';
      return String(id).toLowerCase().startsWith('zh') ? 'zh' : 'en';
    }

    function useLocale(ctx) {
      const [snapshot, setSnapshot] = React.useState(() => ctx.locale.getSnapshot());
      React.useEffect(() => {
        const update = () => setSnapshot(ctx.locale.getSnapshot());
        update();
        return ctx.locale.subscribe(update);
      }, [ctx]);
      return snapshot;
    }

    function Icon(props) {
      const paths = ICONS[props.name] ?? ICONS.bell;
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 18,
        height: 18,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, paths.map((d, index) => h('path', { key: index, d })));
    }

    /** One settings request; the Host half owns validation and persistence. */
    async function requestSettings(method, body) {
      const init = { method, headers: { ...HEADER }, cache: 'no-store' };
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const response = await fetch(ENDPOINT, init);
      if (!response.ok) throw new Error(`settings request failed: HTTP ${response.status}`);
      const value = await response.json();
      return { enabled: value?.enabled !== false, sound: value?.sound !== false };
    }

    /**
     * The popup click only focuses the desktop window; the Host stores which
     * Session it came from and the focused Client reads it once here.
     */
    async function consumeActivation(ctx) {
      if (activationBusy) return;
      activationBusy = true;
      try {
        const response = await fetch(ACTIVATE_ENDPOINT, { headers: { ...HEADER }, cache: 'no-store' });
        if (!response.ok) return;
        const value = await response.json();
        if (typeof value?.sessionId !== 'string' || value.sessionId === '') return;
        const workspace = ctx.get('uiWorkspace');
        if (workspace !== undefined && typeof workspace.openSession === 'function') {
          workspace.openSession(value.sessionId);
        }
      } catch (error) {
        console.error('[session-done-notifier] activation read failed', error);
      } finally {
        activationBusy = false;
      }
    }

    /**
     * The approval waterfall is claimed by the Client answerer, so the Host
     * cannot observe it. The Client knows its pending approvals and reports a
     * new one to the Host, which shows the same desktop popup.
     */
    async function reportApproval(sessionId, interaction) {
      try {
        await fetch(PENDING_ENDPOINT, {
          method: 'POST',
          headers: { ...HEADER, 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            kind: 'approval',
            toolName: interaction?.toolName,
            callId: interaction?.callId,
            reason: interaction?.reason,
            displayReason: interaction?.displayReason,
          }),
        });
      } catch (error) {
        console.error('[session-done-notifier] approval report failed', error);
      }
    }

    function Toggle(props) {
      return h('button', {
        type: 'button',
        className: `g1-sdn-toggle ${props.active ? 'is-on' : 'is-off'}`,
        title: props.hint,
        'aria-label': props.label,
        'aria-pressed': props.active,
        disabled: props.disabled,
        onClick: props.onClick,
      }, h(Icon, { name: props.icon }));
    }

    function Controls(props) {
      const { ctx, t } = props;
      useLocale(ctx);
      const [state, setState] = React.useState({ phase: 'loading', enabled: true, sound: true });
      const latest = React.useRef(state);
      latest.current = state;

      React.useEffect(() => {
        let active = true;
        requestSettings('GET')
          .then((value) => {
            if (active) setState({ phase: 'ready', ...value });
          })
          .catch((error) => {
            console.error('[session-done-notifier] settings read failed', error);
            if (active) setState({ phase: 'error', enabled: true, sound: true });
          });
        return () => { active = false; };
      }, []);

      const toggle = React.useCallback((key) => {
        const previous = latest.current;
        const next = { ...previous, phase: 'ready', [key]: !previous[key] };
        setState(next);
        requestSettings('POST', { [key]: next[key] })
          .then((value) => setState({ phase: 'ready', ...value }))
          .catch((error) => {
            console.error('[session-done-notifier] settings write failed', error);
            setState(previous);
          });
      }, []);

      const busy = state.phase === 'loading';
      return h(React.Fragment, null,
        h('style', { 'data-session-done-notifier-style': '' }, CSS),
        h(Toggle, {
          icon: state.enabled ? 'bell' : 'bellOff',
          active: state.enabled,
          label: t('popup'),
          hint: state.enabled ? t('popupOn') : t('popupOff'),
          disabled: busy,
          onClick: () => toggle('enabled'),
        }),
        h(Toggle, {
          icon: state.sound ? 'speaker' : 'speakerOff',
          active: state.sound,
          label: t('sound'),
          hint: state.sound ? t('soundOn') : t('soundOff'),
          disabled: busy,
          onClick: () => toggle('sound'),
        }));
    }

    return {
      inject: ['slots', 'locale', 'uiSession'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICT), 'session-done-notifier: dictionaries');
        const t = ctx.locale.bind(NS);
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'session-done-notifier',
          order: 60,
          locale: NS,
        }, (slotProps) => h(Controls, { ...slotProps, ctx, t })));

        // A popup click focuses the window and leaves its Session for this
        // focused Client to reopen.
        ctx.effect(() => {
          const check = () => { void consumeActivation(ctx); };
          const onVisibility = () => {
            if (document.visibilityState === 'visible') check();
          };
          window.addEventListener('focus', check);
          document.addEventListener('visibilitychange', onVisibility);
          return () => {
            window.removeEventListener('focus', check);
            document.removeEventListener('visibilitychange', onVisibility);
          };
        }, 'session-done-notifier: popup click navigation');

        // Approval prompts never reach a Host waterfall listener, so report
        // the Client's own pending approval to the Host popup route.
        ctx.effect(() => {
          const status = ctx.uiSession?.sessionStatus;
          if (status === undefined || typeof status.subscribe !== 'function') return;
          let previous = new Map();
          const publish = () => {
            const snapshot = status.getSnapshot();
            for (const [sessionId, value] of snapshot) {
              const interaction = value?.pendingInteraction;
              const before = previous.get(sessionId)?.pendingInteraction;
              if (interaction?.kind === 'approval' && interaction !== before) {
                void reportApproval(sessionId, interaction);
              }
            }
            previous = snapshot;
          };
          const unsubscribe = status.subscribe(publish);
          publish();
          return unsubscribe;
        }, 'session-done-notifier: approval pending observer');
      },
    };
  },
});
