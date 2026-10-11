import sys, threading, http.server, socketserver, functools, re
from playwright.sync_api import sync_playwright
root=sys.argv[1]
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*a): pass
srv=socketserver.TCPServer(("127.0.0.1",0),functools.partial(Q,directory=root)); port=srv.server_address[1]
threading.Thread(target=srv.serve_forever,daemon=True).start()
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={'width':390,'height':844})
    ctx.route(re.compile(r'https?://(?!127\.0\.0\.1).*'), lambda r: r.abort())
    pg=ctx.new_page(); errs=[]
    pg.on('pageerror',lambda e:errs.append(str(e)))
    pg.goto(f'http://127.0.0.1:{port}/index.html'); pg.wait_for_timeout(2500)
    print('sw controlling after load+wait:', pg.evaluate("navigator.serviceWorker.getRegistration().then(r=>!!(r&&r.active))"))
    pg.reload(); pg.wait_for_timeout(1000)
    ctx.set_offline(True); pg.reload(); pg.wait_for_timeout(1500)
    print('offline render ok:', pg.evaluate("!!document.querySelector('#tl') && document.querySelectorAll('.tabs button').length===4"), 'errors:', errs)
    b.close()
