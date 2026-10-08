// 验客户端半身.mjs —— 造一个假宿主，把 lib/client.js 跑一遍，看它的形态和注册调用对不对
// 用法：node 验客户端半身.mjs
// 说明：这是"能分辨"的判据 —— 它对 ⇒ 说明文件结构、导出、插槽注册调用都是对的，
//       剩下的不确定只剩"宿主认不认 dsh.client 段"（那个要靠真宿主验）。

const FILE = new URL('../lib/client.js', import.meta.url).href;   // 跟着本文件走：换谁的机器、clone 到哪儿都能跑

let loadCalls = 0;
const trace = [];

globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loadCalls += 1;
      console.log('① __ModuleLoader__.load 被调用');
      console.log('   id =', spec.id);
      console.log('   factory 是函数 =', typeof spec.factory === 'function');

      const fakeReact = {
        createElement(type, props, ...children) {
          trace.push('React.createElement(' + (typeof type === 'function' ? type.name || '匿名组件' : String(type)) + ')');
          return { $$typeof: 'fake-element', type, props: props || {}, children };
        },
        useState(initial) {
          trace.push('React.useState(' + JSON.stringify(initial) + ')');
          return [initial, (v) => trace.push('setState(' + JSON.stringify(v) + ')')];
        },
        useEffect() { trace.push('React.useEffect'); },
      };

      const deps = [];
      const mod = spec.factory((name) => {
        deps.push(name);
        if (name === 'react') return fakeReact;
        throw new Error('它要了我没准备的依赖：' + name);
      });

      console.log('② factory 跑通，它 require 了：', deps.join(', ') || '（无）');
      console.log('③ 导出：', Object.keys(mod).join(', '), '｜ apply 是函数 =', typeof mod.apply === 'function');
      console.log('   inject =', JSON.stringify(mod.inject));

      // ④ 造一个假 ctx，看 apply 会怎么注册
      const slots = {
        inject(key, cb) {
          trace.push('slots.inject(' + key + ')');
          return cb();
        },
        register(opts, component) {
          trace.push('slots.register(id=' + opts.id + ', order=' + opts.order + ')');
          trace.push('组件是函数 = ' + (typeof component === 'function'));
          // ⑤ 把组件真渲染一次（看它会不会抛错）
          try {
            const el = component({ sessionId: 'session-假的' });
            trace.push('组件渲染成功，根节点 = ' + JSON.stringify(el.type));
          } catch (e) {
            trace.push('❌ 组件渲染抛错：' + e.message);
          }
          return () => { trace.push('dispose()'); };
        },
      };
      const fakeCtx = {
        get(name) {
          trace.push('ctx.get(' + name + ')');
          return name === 'slots' ? slots : undefined;
        },
      };
      mod.apply(fakeCtx);

      console.log('⑤ 调用轨迹：');
      for (const t of trace) console.log('     · ' + t);
    },
  },
};

// fetch 在 node 里有（探针会真发一下，失败也无所谓，文件里已经 .catch 兜住）
await import(FILE);

console.log('');
console.log('=== 结论 ===');
console.log('load 被调用次数 =', loadCalls, loadCalls === 1 ? '✅' : '❌');
const okRegistration = trace.some((t) => t.startsWith('slots.register(id=office-connect'));
console.log('挂进 conversation.input.dock =', trace.includes('slots.inject(conversation.input.dock)') ? '✅' : '❌');
console.log('注册条目 office-connect =', okRegistration ? '✅' : '❌');
console.log('组件能渲染 =', trace.some((t) => t.startsWith('组件渲染成功')) ? '✅' : '❌');
const bad = trace.filter((t) => t.startsWith('❌'));
if (bad.length) { console.log('发现的问题：'); for (const b of bad) console.log('  ' + b); }
