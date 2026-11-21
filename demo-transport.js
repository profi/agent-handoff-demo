export async function createDemoTransport() {
  const bundled = await fetch(new URL('./demo-data.json', import.meta.url));
  if (!bundled.ok) throw new Error('The bundled demo could not be loaded.');
  const { run, phases, sources } = await bundled.json();
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const unavailable = () => response({ error: 'This record is unavailable in the selected replay phase.' }, 404);

  return async (input, options) => {
    if (options?.method && options.method !== 'GET') return response({ error: 'The demo is read-only.' }, 405);
    const { pathname, searchParams } = new URL(input, 'https://demo.invalid');
    if (pathname === '/api/runs') return response([run]);
    const route = /^\/api\/runs\/demo\/phases\/(\d+)(?:\/(.*))?$/.exec(pathname);
    const view = route && phases[Number(route[1])];
    if (!view) return unavailable();
    const tail = route[2];
    if (!tail) return response(view);
    if (tail === 'snapshot') {
      const { thread_id, messages, publications, requests, complete } = view;
      return response({ thread_id, messages, publications, requests, complete });
    }
    const id = /^messages\/([a-z-]+)$/.exec(tail)?.[1];
    if (id) {
      const message = view.messages.find(item => item.message_id === id);
      return message ? response(message) : unavailable();
    }
    if (tail !== 'source') return unavailable();
    const repository = searchParams.get('repository'), commit = searchParams.get('commit');
    if (!view.messages.some(message => message.source_repository === repository && message.source_commit === commit)) return unavailable();
    const files = sources[commit];
    const file = searchParams.get('path');
    if (file === null) return response({ repository, commit, files: Object.keys(files) });
    return Object.hasOwn(files, file) ? response({ repository, commit, path: file, text: files[file] }) : unavailable();
  };
}
