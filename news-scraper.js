// ══════════════════════════════════════════════════════════════════
// SCRAPER DE NOTICIAS DEL GOBIERNO DE GUINEA ECUATORIAL
// ══════════════════════════════════════════════════════════════════
// Revisa las páginas oficiales cada 10 minutos y envía push notifications

const { createClient } = require('@supabase/supabase-js');
const webpush = require('web-push');

// Configuración
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || ''
);

// Web Push VAPID keys (las mismas que usa el SW)
const VAPID_PUBLIC_KEY = 'BNeDJFYqIX59vgqEKxWfrI263knyPGHafMEK_WrMPeYaIm8bn62vcOah7hDlgIek4R4utB82g-cT9CwAtGn0wUs';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';

if (VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:admin@egchat.gq',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}

// Fuentes oficiales del gobierno
const SOURCES = [
  {
    name: 'Guinea Ecuatorial Press',
    url: 'https://www.guineaecuatorialpress.com',
    color: '#0369a1',
    category: 'Prensa Oficial'
  },
  {
    name: 'Presidencia Gobierno GQ',
    url: 'https://www.presidenciagobierno.gq',
    color: '#1e3a5f',
    category: 'Presidencia'
  },
  {
    name: 'La Vice Press',
    url: 'https://www.lavicepress.com',
    color: '#0d9488',
    category: 'Vicepresidencia'
  }
];

// Scraper simple usando fetch (sin dependencias pesadas)
async function scrapeNews(source) {
  try {
    const response = await fetch(source.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 10000
    });

    if (!response.ok) {
      console.log(`❌ ${source.name}: HTTP ${response.status}`);
      return [];
    }

    const html = await response.text();
    
    // Extraer noticias usando regex simple (buscar títulos y enlaces)
    const newsItems = [];
    
    // Patrones comunes para detectar noticias
    const patterns = [
      /<article[^>]*>[\s\S]*?<h[23][^>]*>(.*?)<\/h[23]>[\s\S]*?<a[^>]*href=["']([^"']+)["'][^>]*>/gi,
      /<div[^>]*class=["'][^"']*post[^"']*["'][^>]*>[\s\S]*?<h[23][^>]*>(.*?)<\/h[23]>[\s\S]*?<a[^>]*href=["']([^"']+)["'][^>]*>/gi,
      /<h[23][^>]*><a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a><\/h[23]>/gi
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(html)) !== null && newsItems.length < 10) {
        const title = match[1] || match[2];
        const url = match[2] || match[1];
        
        if (title && url && title.length > 10 && title.length < 200) {
          const cleanTitle = title
            .replace(/<[^>]+>/g, '')
            .replace(/&[a-z]+;/gi, ' ')
            .trim();
          
          const fullUrl = url.startsWith('http') ? url : `${source.url}${url}`;
          
          newsItems.push({
            title: cleanTitle,
            url: fullUrl,
            source: source.name,
            color: source.color,
            category: source.category
          });
        }
      }
    }

    return newsItems.slice(0, 5); // Máximo 5 noticias por fuente
  } catch (error) {
    console.error(`Error scraping ${source.name}:`, error.message);
    return [];
  }
}

// Guardar noticia en la base de datos
async function saveNews(newsItem) {
  try {
    // Verificar si ya existe (por URL)
    const { data: existing } = await supabase
      .from('government_news')
      .select('id')
      .eq('url', newsItem.url)
      .maybeSingle();

    if (existing) {
      return { isNew: false, id: existing.id };
    }

    // Insertar nueva noticia
    const { data, error } = await supabase
      .from('government_news')
      .insert({
        title: newsItem.title,
        url: newsItem.url,
        source: newsItem.source,
        color: newsItem.color,
        category: newsItem.category,
        scraped_at: new Date().toISOString()
      })
      .select('id')
      .single();

    if (error) throw error;

    return { isNew: true, id: data.id, news: newsItem };
  } catch (error) {
    console.error('Error saving news:', error.message);
    return { isNew: false, error: error.message };
  }
}

// Enviar push notification a todos los usuarios suscritos
async function sendPushNotification(newsItem) {
  try {
    if (!VAPID_PRIVATE_KEY) {
      console.log('⚠️  VAPID_PRIVATE_KEY no configurada, skip push');
      return;
    }

    // Obtener todas las suscripciones activas
    const { data: subscriptions, error } = await supabase
      .from('push_subscriptions')
      .select('*')
      .eq('active', true);

    if (error || !subscriptions || subscriptions.length === 0) {
      console.log('No hay suscripciones activas');
      return;
    }

    const payload = JSON.stringify({
      title: '🏛️ Gobierno GE - Nueva Noticia',
      body: newsItem.title,
      notificationType: 'government_news',
      newsId: newsItem.id,
      url: '/?view=news',
      tag: 'gov-news',
      icon: '/favicon.svg',
      badge: '/favicon.svg'
    });

    let sent = 0;
    let failed = 0;

    for (const sub of subscriptions) {
      try {
        await webpush.sendNotification(sub.subscription, payload);
        sent++;
      } catch (err) {
        failed++;
        // Si la suscripción expiró (410), marcarla como inactiva
        if (err.statusCode === 410) {
          await supabase
            .from('push_subscriptions')
            .update({ active: false })
            .eq('id', sub.id);
        }
      }
    }

    console.log(`📢 Push enviado: ${sent} exitosos, ${failed} fallidos`);
  } catch (error) {
    console.error('Error sending push:', error.message);
  }
}

// Proceso principal de scraping
async function runScraper() {
  console.log('\n🔍 Iniciando scraping de noticias del gobierno...');
  console.log(`⏰ ${new Date().toLocaleString('es-ES', { timeZone: 'Africa/Malabo' })}`);

  let totalNew = 0;

  for (const source of SOURCES) {
    console.log(`\n📰 Scraping: ${source.name}`);
    const newsItems = await scrapeNews(source);
    
    console.log(`   Encontradas: ${newsItems.length} noticias`);

    for (const item of newsItems) {
      const result = await saveNews(item);
      
      if (result.isNew) {
        totalNew++;
        console.log(`   ✅ NUEVA: ${item.title.substring(0, 60)}...`);
        
        // Enviar push notification
        await sendPushNotification({ ...item, id: result.id });
        
        // Esperar 2 segundos entre notificaciones para no saturar
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  console.log(`\n✨ Scraping completado: ${totalNew} noticias nuevas`);
  return totalNew;
}

// Ejecutar cada 10 minutos
const INTERVAL = 10 * 60 * 1000; // 10 minutos

async function startScheduler() {
  console.log('🚀 Scraper de noticias del gobierno iniciado');
  console.log(`⏱️  Intervalo: cada ${INTERVAL / 60000} minutos`);
  
  // Ejecutar inmediatamente al iniciar
  await runScraper();
  
  // Luego cada 10 minutos
  setInterval(async () => {
    try {
      await runScraper();
    } catch (error) {
      console.error('Error en scraper:', error);
    }
  }, INTERVAL);
}

// Si se ejecuta directamente
if (require.main === module) {
  startScheduler();
}

module.exports = { runScraper, startScheduler };
