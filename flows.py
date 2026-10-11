import sys, threading, http.server, socketserver, functools, json, re, datetime
from playwright.sync_api import sync_playwright
root, out = sys.argv[1], sys.argv[2]
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*a): pass
srv = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Q, directory=root)); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
DAY='Sun Oct 11 2026'
fixture = {
 'setup': True,
 'blocks': {
  'pre':[{'id':'p1','t':'Water','d':10,'m':5,'p':'core'},{'id':'p2','t':'Breakfast','d':20,'m':10,'p':'flex'},{'id':'p3','t':'Stretch','d':15,'m':5,'p':'opt'}],
  'night':[{'id':'n1','t':'Wash up','d':15,'m':10,'p':'core'},{'id':'n2','t':'Read','d':30,'m':10,'p':'opt'}],
  'home':[{'id':'h1','t':'Deep work','d':90,'p':'fixedlen','w':'peak','details':'Focus','steps':['a','b']},{'id':'h2','t':'Lunch','d':30,'p':'fixedlen','w':'trough','fixed':750},{'id':'h3','t':'Walk','d':20,'p':'fixedlen','w':'climb2'}],
 },
 'plans': {DAY: {'w':300,'d':[],'t':{'climb1':'home','peak':'home','trough':'home','climb2':'home','wmz':'home'},'a':False,'n':'hello','o':[{'id':'o1','t':'Dentist call','d':15,'p':'fixedlen','w':'climb1'}],'l':False,'s':None}},
 'wake': 300,
}
def norm(s): return re.sub(r'\s+',' ',s).strip()
snaps={}; errs=[]
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width':390,'height':844}, timezone_id='UTC', locale='en-US', service_workers='block')
    ctx.route(re.compile(r'https?://(?!127\.0\.0\.1).*'), lambda r: r.abort())
    ctx.add_init_script("if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');const f=%s;for(const k in f)localStorage.setItem('yotei_v2_'+k,JSON.stringify(f[k]));}" % json.dumps(fixture))
    pg = ctx.new_page()
    pg.clock.set_fixed_time(datetime.datetime(2026,10,11,9,30,0))
    pg.on('pageerror', lambda e: errs.append('PAGEERROR '+str(e)))
    pg.on('console', lambda m: errs.append('CONSOLE '+m.text) if m.type=='error' and 'net::ERR' not in m.text else None)
    pg.goto(f'http://127.0.0.1:{port}/index.html'); pg.wait_for_timeout(1200)
    def snap(name):
        snaps[name] = {
          'tl': norm(pg.inner_html('#tl')), 'msg': pg.inner_text('#msg'), 'now': norm(pg.inner_text('#nowBanner')),
          'strip': norm(pg.inner_text('#weekstrip')), 'prog': pg.inner_text('#prog'),
          'tab': pg.evaluate("document.body.dataset.tab"),
          'storage': pg.evaluate("Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('yotei_v2_')&&!['yotei_v2_lastBackup','yotei_v2_bkAsk'].includes(k)).sort().map(k=>[k,localStorage.getItem(k)]))"),
        }
    pg.on('dialog', lambda d: d.accept())
    def flow(name, fn):
        try: fn()
        except Exception as e: snaps['FLOWERR_'+name]={'err':str(e).split('\n')[0][:200]}
    def S(name, sel='#tl'): snaps[name]={'html':norm(pg.inner_html(sel)),'open':pg.evaluate("[...document.querySelectorAll('dialog')].filter(d=>d.open).map(d=>d.id)")}
    def f_add():
        pg.click('#fab'); pg.wait_for_timeout(250); pg.click('#fabMenu [data-a=add]'); pg.wait_for_timeout(300); S('add_open','#ed')
        pg.fill('#e_t','Flow test task'); pg.click('#e_iconBtn'); pg.wait_for_timeout(300); S('icon_picker','#iconPick')
        pg.fill('.ipSearch input','book'); pg.wait_for_timeout(300); S('icon_search','#ip_groups')
        pg.click('#ip_x'); pg.wait_for_timeout(250); pg.click('#e_ok'); pg.wait_for_timeout(400); S('after_add_save')
        if pg.evaluate("document.getElementById('scopeDlg').open"):
            pg.click('#sc_opts button'); pg.wait_for_timeout(400)
        S('after_scope')
    flow('add', f_add)
    def f_late():
        pg.click('#fab'); pg.wait_for_timeout(250); pg.click('#fabMenu [data-a=late]'); pg.wait_for_timeout(300)
        pg.click('#sh_chips button'); pg.click('#sh_ok'); pg.wait_for_timeout(400); S('after_late')
    flow('late', f_late)
    def f_inbox():
        pg.click('.tabs [data-tab=inbox]'); pg.wait_for_timeout(250); pg.fill('#inT','Buy milk'); pg.keyboard.press('Enter'); pg.wait_for_timeout(300); S('inbox_after','#tab-inbox')
    flow('inbox', f_inbox)
    def f_sheet():
        pg.click('.tabs [data-tab=home]'); pg.wait_for_timeout(250); pg.query_selector_all('.tlrow .tldot')[0].click(); pg.wait_for_timeout(300)
        pg.click('#ts_move'); pg.wait_for_timeout(300); S('move_dlg','#mvDlg'); pg.click('#mv_x'); pg.wait_for_timeout(200)
    flow('sheet', f_sheet)
    def f_timer():
        pg.query_selector_all('.tlrow .tldot')[0].click(); pg.wait_for_timeout(300); pg.click('#ts_timer'); pg.wait_for_timeout(400)
        S('timer_open','#runDlg'); pg.click('#runPause'); pg.click('#runClose'); pg.wait_for_timeout(200)
    flow('timer', f_timer)
    def f_tpl():
        pg.click('.tabs [data-tab=settings]'); pg.wait_for_timeout(250); pg.click('[data-tpl]'); pg.wait_for_timeout(400); S('tpl_applied','#tab-settings')
    flow('tpl', f_tpl)
    def f_edit_win():
        pg.click('.tabs [data-tab=home]'); pg.wait_for_timeout(250); S('final_home')
    flow('final', f_edit_win)
    snaps['storage_end']=pg.evaluate("Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('yotei_v2_')&&!['yotei_v2_lastBackup','yotei_v2_bkAsk'].includes(k)).sort().map(k=>[k,localStorage.getItem(k)]))")
    b.close()
json.dump({'snaps':snaps,'errs':errs}, open(out,'w'), indent=1, sort_keys=True)
print('errors:', errs); print({k:('ERR '+v['err'] if 'err' in v else 'ok') for k,v in snaps.items() if k.startswith('FLOWERR')} or 'no flow errors')
