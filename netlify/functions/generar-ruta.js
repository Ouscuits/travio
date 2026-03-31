// Netlify Function para Travio - Con soporte multiidioma
exports.handler = async (event, context) => {
  // Solo permitir POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  // Habilitar CORS
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Manejar preflight request
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  try {
    // Parsear el body de la petición
    const { prompt, language = 'es' } = JSON.parse(event.body);

    if (!prompt) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing prompt' })
      };
    }

    // Generar respuesta simulada en el idioma apropiado
    const respuestaSimulada = generarRutaSimulada(prompt, language);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        content: [{
          type: 'text',
          text: respuestaSimulada
        }]
      })
    };

  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Error processing request',
        details: error.message 
      })
    };
  }
};

// Función que genera una ruta simulada basada en el prompt y el idioma
function generarRutaSimulada(prompt, language) {
  // Extraer información básica del prompt
  const lineas = prompt.split('\n');
  let partida = '', final = '', destinos = '', dias = '', presupuesto = '', tipoViaje = '';
  
  lineas.forEach(linea => {
    if (linea.includes('Starting point:') || linea.includes('Punto de partida:') || 
        linea.includes('Punt de partida:') || linea.includes('Point de départ:') || 
        linea.includes('出发点：')) {
      partida = linea.split(':')[1].trim();
    }
    if (linea.includes('End point:') || linea.includes('Punto final:') || 
        linea.includes('Punt final:') || linea.includes('Point d\'arrivée:') || 
        linea.includes('终点：')) {
      final = linea.split(':')[1].trim();
    }
    if (linea.includes('Destinations to visit:') || linea.includes('Destinos a visitar:') || 
        linea.includes('Destinacions a visitar:') || linea.includes('Destinations à visiter:') || 
        linea.includes('要访问的目的地：')) {
      destinos = linea.split(':')[1].trim();
    }
    if (linea.includes('Duration:') || linea.includes('Duración:') || 
        linea.includes('Durada:') || linea.includes('Durée:') || 
        linea.includes('持续时间：')) {
      dias = linea.split(':')[1].trim().split(' ')[0];
    }
    if (linea.includes('Daily budget:') || linea.includes('Presupuesto diario:') || 
        linea.includes('Pressupost diari:') || linea.includes('Budget quotidien:') || 
        linea.includes('每日预算：')) {
      presupuesto = linea.split(':')[1].trim();
    }
    if (linea.includes('Trip type:') || linea.includes('Tipo de viaje:') || 
        linea.includes('Tipus de viatge:') || linea.includes('Type de voyage:') || 
        linea.includes('旅行类型：')) {
      tipoViaje = linea.split(':')[1].trim();
    }
  });

  // Obtener plantillas de texto según el idioma
  const templates = getTemplates(language);
  
  // Generar respuesta estructurada en el idioma apropiado
  return `# 🗺️ ${templates.optimizedRoute}: ${partida} → ${final}

## 📍 ${templates.detailedItinerary}

### ${templates.day} 1: ${partida} → ${templates.firstDestination}
**${templates.distance}:** ~200 km  
**${templates.drivingTime}:** 2h 30min  
**${templates.departureTime}:** 09:00  
**${templates.estimatedArrival}:** 11:30

**${templates.estimatedCosts}:**
- ${templates.fuel}: €21 (200km × 7L/100km × €1.50/L)
- ${templates.tolls}: €12
- ${templates.meals}: €35
- ${templates.accommodation}: €60
- **${templates.totalDay} 1:** €128

**${templates.suggestionsFor} ${tipoViaje}:**
${getSugerenciasTipoViaje(tipoViaje, language)}

**${templates.recommendedStops}:**
- ${templates.picturesqueVillage}
- ${templates.scenicViewpoint}

---

### ${templates.day} 2: ${templates.exploringArea}
**${templates.dayActivities}:**
- ${templates.morningVisit}
- ${templates.lunchLocal}
- ${templates.afternoonActivity}

**${templates.estimatedCosts}:**
- ${templates.localFuel}: €8
- ${templates.meals}: €40
- ${templates.activities}: €20
- ${templates.accommodation}: €60
- **${templates.totalDay} 2:** €128

---

### ${templates.day} 3: ${templates.returnTo} ${final}
**${templates.distance}:** ~200 km  
**${templates.drivingTime}:** 2h 30min  
**${templates.suggestedDeparture}:** 10:00  
**${templates.estimatedArrival}:** 12:30

**${templates.estimatedCosts}:**
- ${templates.fuel}: €21
- ${templates.tolls}: €12
- ${templates.meals}: €30
- **${templates.totalDay} 3:** €63

---

## 💰 ${templates.financialSummary}

**${templates.totalBudgetAvailable}:** ${presupuesto} × ${dias} ${templates.days} = €${parseInt(presupuesto.replace('€','')) * parseInt(dias)}

**${templates.estimatedTotalCost}:** €319

**${templates.balance}:** ${parseInt(presupuesto.replace('€','')) * parseInt(dias) - 319 > 0 ? '✅ ' + templates.withinBudget : '⚠️ ' + templates.slightlyOver} 
${parseInt(presupuesto.replace('€','')) * parseInt(dias) - 319 > 0 ? 
  `(${templates.remaining}: €${parseInt(presupuesto.replace('€','')) * parseInt(dias) - 319})` : 
  `(${templates.excess}: €${319 - parseInt(presupuesto.replace('€','')) * parseInt(dias)})`}

---

## 🎯 ${templates.keyTripData}

- **${templates.totalKilometers}:** ~400 km
- **${templates.totalDrivingTime}:** 5 ${templates.hours}
- **${templates.numberOfStops}:** 3 ${templates.mainStops} + 2 ${templates.intermediate}
- **${templates.bestTimeTravel}:** ${templates.springAutumn}

---

## 💡 ${templates.practicalTips}

1. **${templates.bookAdvance}:** ${templates.bookAdvanceDetail}
2. **${templates.downloadMaps}:** ${templates.downloadMapsDetail}
3. **${templates.fuel}:** ${templates.fuelDetail}
4. **${templates.schedule}:** ${templates.scheduleDetail}

---

## 📱 ${templates.nextSteps}

1. ${templates.saveRoute}
2. ${templates.bookAccommodation}
3. ${templates.checkSchedules}
4. ${templates.downloadOfflineMaps}

${templates.enjoyTrip} 🚗✨

---

*${templates.note}*`;
}

function getTemplates(language) {
  const templates = {
    es: {
      optimizedRoute: "RUTA OPTIMIZADA",
      detailedItinerary: "ITINERARIO DETALLADO",
      day: "DÍA",
      firstDestination: "Primer destino",
      distance: "Distancia",
      drivingTime: "Tiempo de conducción",
      departureTime: "Hora de salida",
      estimatedArrival: "Llegada estimada",
      estimatedCosts: "Costes estimados",
      fuel: "Gasolina",
      tolls: "Peajes",
      meals: "Comidas",
      accommodation: "Alojamiento",
      totalDay: "TOTAL DÍA",
      suggestionsFor: "Sugerencias para viaje",
      recommendedStops: "Paradas intermedias recomendadas",
      picturesqueVillage: "Pueblo pintoresco a mitad de camino (descanso + café)",
      scenicViewpoint: "Mirador panorámico",
      exploringArea: "Explorando la zona",
      dayActivities: "Actividades del día",
      morningVisit: "Visita matinal al centro histórico",
      lunchLocal: "Comida en restaurante local recomendado",
      afternoonActivity: "Tarde: actividad según tipo de viaje",
      localFuel: "Gasolina local",
      activities: "Actividades",
      returnTo: "Regreso a",
      suggestedDeparture: "Hora de salida sugerida",
      financialSummary: "RESUMEN FINANCIERO",
      totalBudgetAvailable: "Presupuesto total disponible",
      days: "días",
      estimatedTotalCost: "Coste total estimado",
      balance: "Balance",
      withinBudget: "Dentro del presupuesto",
      slightlyOver: "Ligeramente por encima",
      remaining: "Te sobran",
      excess: "Exceso",
      keyTripData: "DATOS CLAVE DEL VIAJE",
      totalKilometers: "Kilómetros totales",
      totalDrivingTime: "Tiempo total de conducción",
      hours: "horas",
      numberOfStops: "Número de paradas",
      mainStops: "principales",
      intermediate: "intermedias",
      bestTimeTravel: "Mejor momento para viajar",
      springAutumn: "Primavera u otoño (menos turistas)",
      practicalTips: "CONSEJOS PRÁCTICOS",
      bookAdvance: "Reserva con anticipación",
      bookAdvanceDetail: "Especialmente alojamiento en temporada alta",
      downloadMaps: "Descarga mapas offline",
      downloadMapsDetail: "Por si pierdes señal en zonas rurales",
      fuelDetail: "Llena el tanque antes de salir de ciudades grandes",
      schedule: "Horarios",
      scheduleDetail: "Evita conducir en horas punta (7-9am, 6-8pm)",
      nextSteps: "PRÓXIMOS PASOS",
      saveRoute: "Guarda esta ruta en tu app",
      bookAccommodation: "Reserva alojamientos",
      checkSchedules: "Verifica horarios de atracciones principales",
      downloadOfflineMaps: "Descarga mapas offline de la zona",
      enjoyTrip: "¡Disfruta tu viaje!",
      note: "Nota: Esta es una planificación básica. Para una ruta más detallada con información actualizada de tráfico, peajes exactos y recomendaciones personalizadas en tiempo real, necesitarás conectar con servicios de mapas en vivo."
    },
    en: {
      optimizedRoute: "OPTIMIZED ROUTE",
      detailedItinerary: "DETAILED ITINERARY",
      day: "DAY",
      firstDestination: "First destination",
      distance: "Distance",
      drivingTime: "Driving time",
      departureTime: "Departure time",
      estimatedArrival: "Estimated arrival",
      estimatedCosts: "Estimated costs",
      fuel: "Fuel",
      tolls: "Tolls",
      meals: "Meals",
      accommodation: "Accommodation",
      totalDay: "TOTAL DAY",
      suggestionsFor: "Suggestions for",
      recommendedStops: "Recommended intermediate stops",
      picturesqueVillage: "Picturesque village halfway (rest + coffee)",
      scenicViewpoint: "Scenic viewpoint",
      exploringArea: "Exploring the area",
      dayActivities: "Day activities",
      morningVisit: "Morning visit to the historic center",
      lunchLocal: "Lunch at recommended local restaurant",
      afternoonActivity: "Afternoon: activity according to trip type",
      localFuel: "Local fuel",
      activities: "Activities",
      returnTo: "Return to",
      suggestedDeparture: "Suggested departure time",
      financialSummary: "FINANCIAL SUMMARY",
      totalBudgetAvailable: "Total budget available",
      days: "days",
      estimatedTotalCost: "Estimated total cost",
      balance: "Balance",
      withinBudget: "Within budget",
      slightlyOver: "Slightly over",
      remaining: "You have left",
      excess: "Excess",
      keyTripData: "KEY TRIP DATA",
      totalKilometers: "Total kilometers",
      totalDrivingTime: "Total driving time",
      hours: "hours",
      numberOfStops: "Number of stops",
      mainStops: "main",
      intermediate: "intermediate",
      bestTimeTravel: "Best time to travel",
      springAutumn: "Spring or autumn (fewer tourists)",
      practicalTips: "PRACTICAL TIPS",
      bookAdvance: "Book in advance",
      bookAdvanceDetail: "Especially accommodation during high season",
      downloadMaps: "Download offline maps",
      downloadMapsDetail: "In case you lose signal in rural areas",
      fuelDetail: "Fill up the tank before leaving big cities",
      schedule: "Schedule",
      scheduleDetail: "Avoid driving during rush hours (7-9am, 6-8pm)",
      nextSteps: "NEXT STEPS",
      saveRoute: "Save this route in your app",
      bookAccommodation: "Book accommodation",
      checkSchedules: "Check schedules of main attractions",
      downloadOfflineMaps: "Download offline maps of the area",
      enjoyTrip: "Enjoy your trip!",
      note: "Note: This is basic planning. For a more detailed route with updated traffic information, exact tolls and real-time personalized recommendations, you will need to connect to live map services."
    },
    ca: {
      optimizedRoute: "RUTA OPTIMITZADA",
      detailedItinerary: "ITINERARI DETALLAT",
      day: "DIA",
      firstDestination: "Primer destí",
      distance: "Distància",
      drivingTime: "Temps de conducció",
      departureTime: "Hora de sortida",
      estimatedArrival: "Arribada estimada",
      estimatedCosts: "Costos estimats",
      fuel: "Gasolina",
      tolls: "Peatges",
      meals: "Menjars",
      accommodation: "Allotjament",
      totalDay: "TOTAL DIA",
      suggestionsFor: "Suggeriments per a viatge",
      recommendedStops: "Parades intermèdies recomanades",
      picturesqueVillage: "Poble pintoresc a mig camí (descans + cafè)",
      scenicViewpoint: "Mirador panoràmic",
      exploringArea: "Explorant la zona",
      dayActivities: "Activitats del dia",
      morningVisit: "Visita matinal al centre històric",
      lunchLocal: "Dinar en restaurant local recomanat",
      afternoonActivity: "Tarda: activitat segons tipus de viatge",
      localFuel: "Gasolina local",
      activities: "Activitats",
      returnTo: "Tornada a",
      suggestedDeparture: "Hora de sortida suggerida",
      financialSummary: "RESUM FINANCER",
      totalBudgetAvailable: "Pressupost total disponible",
      days: "dies",
      estimatedTotalCost: "Cost total estimat",
      balance: "Balanç",
      withinBudget: "Dins del pressupost",
      slightlyOver: "Lleugerament per sobre",
      remaining: "Et sobren",
      excess: "Excés",
      keyTripData: "DADES CLAU DEL VIATGE",
      totalKilometers: "Quilòmetres totals",
      totalDrivingTime: "Temps total de conducció",
      hours: "hores",
      numberOfStops: "Nombre de parades",
      mainStops: "principals",
      intermediate: "intermèdies",
      bestTimeTravel: "Millor moment per viatjar",
      springAutumn: "Primavera o tardor (menys turistes)",
      practicalTips: "CONSELLS PRÀCTICS",
      bookAdvance: "Reserva amb anticipació",
      bookAdvanceDetail: "Especialment allotjament en temporada alta",
      downloadMaps: "Descarrega mapes offline",
      downloadMapsDetail: "Per si perds senyal en zones rurals",
      fuelDetail: "Omple el dipòsit abans de sortir de ciutats grans",
      schedule: "Horaris",
      scheduleDetail: "Evita conduir en hores punta (7-9am, 6-8pm)",
      nextSteps: "PROPERS PASSOS",
      saveRoute: "Guarda aquesta ruta a la teva app",
      bookAccommodation: "Reserva allotjaments",
      checkSchedules: "Verifica horaris d'atraccions principals",
      downloadOfflineMaps: "Descarrega mapes offline de la zona",
      enjoyTrip: "Gaudeix del teu viatge!",
      note: "Nota: Aquesta és una planificació bàsica. Per a una ruta més detallada amb informació actualitzada de trànsit, peatges exactes i recomanacions personalitzades en temps real, necessitaràs connectar amb serveis de mapes en viu."
    },
    fr: {
      optimizedRoute: "ITINÉRAIRE OPTIMISÉ",
      detailedItinerary: "ITINÉRAIRE DÉTAILLÉ",
      day: "JOUR",
      firstDestination: "Première destination",
      distance: "Distance",
      drivingTime: "Temps de conduite",
      departureTime: "Heure de départ",
      estimatedArrival: "Arrivée estimée",
      estimatedCosts: "Coûts estimés",
      fuel: "Carburant",
      tolls: "Péages",
      meals: "Repas",
      accommodation: "Hébergement",
      totalDay: "TOTAL JOUR",
      suggestionsFor: "Suggestions pour voyage",
      recommendedStops: "Arrêts intermédiaires recommandés",
      picturesqueVillage: "Village pittoresque à mi-chemin (pause + café)",
      scenicViewpoint: "Point de vue panoramique",
      exploringArea: "Exploration de la zone",
      dayActivities: "Activités de la journée",
      morningVisit: "Visite matinale du centre historique",
      lunchLocal: "Déjeuner au restaurant local recommandé",
      afternoonActivity: "Après-midi: activité selon le type de voyage",
      localFuel: "Carburant local",
      activities: "Activités",
      returnTo: "Retour à",
      suggestedDeparture: "Heure de départ suggérée",
      financialSummary: "RÉSUMÉ FINANCIER",
      totalBudgetAvailable: "Budget total disponible",
      days: "jours",
      estimatedTotalCost: "Coût total estimé",
      balance: "Balance",
      withinBudget: "Dans le budget",
      slightlyOver: "Légèrement au-dessus",
      remaining: "Il vous reste",
      excess: "Excès",
      keyTripData: "DONNÉES CLÉS DU VOYAGE",
      totalKilometers: "Kilomètres totaux",
      totalDrivingTime: "Temps total de conduite",
      hours: "heures",
      numberOfStops: "Nombre d'arrêts",
      mainStops: "principaux",
      intermediate: "intermédiaires",
      bestTimeTravel: "Meilleur moment pour voyager",
      springAutumn: "Printemps ou automne (moins de touristes)",
      practicalTips: "CONSEILS PRATIQUES",
      bookAdvance: "Réservez à l'avance",
      bookAdvanceDetail: "Surtout l'hébergement en haute saison",
      downloadMaps: "Téléchargez des cartes hors ligne",
      downloadMapsDetail: "Au cas où vous perdriez le signal dans les zones rurales",
      fuelDetail: "Faites le plein avant de quitter les grandes villes",
      schedule: "Horaires",
      scheduleDetail: "Évitez de conduire aux heures de pointe (7-9h, 18-20h)",
      nextSteps: "PROCHAINES ÉTAPES",
      saveRoute: "Enregistrez cet itinéraire dans votre application",
      bookAccommodation: "Réservez l'hébergement",
      checkSchedules: "Vérifiez les horaires des principales attractions",
      downloadOfflineMaps: "Téléchargez les cartes hors ligne de la zone",
      enjoyTrip: "Bon voyage!",
      note: "Note: Ceci est une planification de base. Pour un itinéraire plus détaillé avec des informations de trafic à jour, des péages exacts et des recommandations personnalisées en temps réel, vous devrez vous connecter aux services de cartes en direct."
    },
    zh: {
      optimizedRoute: "优化路线",
      detailedItinerary: "详细行程",
      day: "第",
      firstDestination: "第一个目的地",
      distance: "距离",
      drivingTime: "驾驶时间",
      departureTime: "出发时间",
      estimatedArrival: "预计到达",
      estimatedCosts: "预估费用",
      fuel: "燃油",
      tolls: "过路费",
      meals: "餐饮",
      accommodation: "住宿",
      totalDay: "第",
      suggestionsFor: "旅行建议",
      recommendedStops: "推荐中途停留",
      picturesqueVillage: "中途风景如画的村庄（休息+咖啡）",
      scenicViewpoint: "观景台",
      exploringArea: "探索该地区",
      dayActivities: "当天活动",
      morningVisit: "上午参观历史中心",
      lunchLocal: "在推荐的当地餐厅用午餐",
      afternoonActivity: "下午：根据旅行类型的活动",
      localFuel: "当地燃油",
      activities: "活动",
      returnTo: "返回",
      suggestedDeparture: "建议出发时间",
      financialSummary: "财务摘要",
      totalBudgetAvailable: "总预算",
      days: "天",
      estimatedTotalCost: "预计总费用",
      balance: "余额",
      withinBudget: "在预算内",
      slightlyOver: "略微超出",
      remaining: "剩余",
      excess: "超出",
      keyTripData: "关键旅行数据",
      totalKilometers: "总公里数",
      totalDrivingTime: "总驾驶时间",
      hours: "小时",
      numberOfStops: "停靠次数",
      mainStops: "主要",
      intermediate: "中间",
      bestTimeTravel: "最佳旅行时间",
      springAutumn: "春季或秋季（游客较少）",
      practicalTips: "实用建议",
      bookAdvance: "提前预订",
      bookAdvanceDetail: "尤其是旺季的住宿",
      downloadMaps: "下载离线地图",
      downloadMapsDetail: "以防在农村地区失去信号",
      fuelDetail: "离开大城市前加满油箱",
      schedule: "时间表",
      scheduleDetail: "避免在高峰时段驾驶（上午7-9点，下午6-8点）",
      nextSteps: "下一步",
      saveRoute: "在应用中保存此路线",
      bookAccommodation: "预订住宿",
      checkSchedules: "查看主要景点的时间表",
      downloadOfflineMaps: "下载该地区的离线地图",
      enjoyTrip: "祝您旅途愉快！",
      note: "注意：这是基本规划。要获得包含实时交通信息、准确过路费和实时个性化推荐的更详细路线，您需要连接到实时地图服务。"
    }
  };
  
  return templates[language] || templates['es'];
}

function getSugerenciasTipoViaje(tipo, language) {
  const sugerencias = {
    es: {
      'familiar': `- Parque infantil cercano al alojamiento
- Restaurante con menú infantil: "La Familia Feliz"
- Hotel con piscina y zona de juegos
- Visita al museo interactivo (perfecto para niños)`,
      'family': `- Parque infantil cercano al alojamiento
- Restaurante con menú infantil: "La Familia Feliz"
- Hotel con piscina y zona de juegos
- Visita al museo interactivo (perfecto para niños)`,
      'pareja': `- Cena romántica: Restaurante "El Mirador" con vistas
- Hotel boutique con spa
- Paseo al atardecer por el casco antiguo
- Bodega local para cata de vinos`,
      'couple': `- Cena romántica: Restaurante "El Mirador" con vistas
- Hotel boutique con spa
- Paseo al atardecer por el casco antiguo
- Bodega local para cata de vinos`,
      'aventura': `- Ruta de senderismo de 15km (dificultad media)
- Alquiler de kayaks en el río local
- Camping bajo las estrellas (opcional)
- Escalada en roca para principiantes`,
      'adventure': `- Ruta de senderismo de 15km (dificultad media)
- Alquiler de kayaks en el río local
- Camping bajo las estrellas (opcional)
- Escalada en roca para principiantes`,
      'moto': `- Carretera panorámica N-XXX (curvas perfectas)
- Parada técnica: Taller "Moto Service" (km 45)
- Hostal motero "La Curva" (descuento para moteros)
- Ruta alternativa por puerto de montaña (+30min, espectacular)`,
      'motorcycle': `- Carretera panorámica N-XXX (curvas perfectas)
- Parada técnica: Taller "Moto Service" (km 45)
- Hostal motero "La Curva" (descuento para moteros)
- Ruta alternativa por puerto de montaña (+30min, espectacular)`
    },
    en: {
      'family': `- Playground near accommodation
- Family-friendly restaurant: "The Happy Family"
- Hotel with pool and play area
- Visit to interactive museum (perfect for kids)`,
      'familiar': `- Playground near accommodation
- Family-friendly restaurant: "The Happy Family"
- Hotel with pool and play area
- Visit to interactive museum (perfect for kids)`,
      'couple': `- Romantic dinner: "The Viewpoint" restaurant with views
- Boutique hotel with spa
- Sunset walk through old town
- Local winery for wine tasting`,
      'pareja': `- Romantic dinner: "The Viewpoint" restaurant with views
- Boutique hotel with spa
- Sunset walk through old town
- Local winery for wine tasting`,
      'adventure': `- 15km hiking trail (medium difficulty)
- Kayak rental on local river
- Camping under the stars (optional)
- Rock climbing for beginners`,
      'aventura': `- 15km hiking trail (medium difficulty)
- Kayak rental on local river
- Camping under the stars (optional)
- Rock climbing for beginners`,
      'motorcycle': `- Scenic road N-XXX (perfect curves)
- Technical stop: "Moto Service" workshop (km 45)
- Biker hostel "La Curva" (discount for bikers)
- Alternative route through mountain pass (+30min, spectacular)`,
      'moto': `- Scenic road N-XXX (perfect curves)
- Technical stop: "Moto Service" workshop (km 45)
- Biker hostel "La Curva" (discount for bikers)
- Alternative route through mountain pass (+30min, spectacular)`
    },
    ca: {
      'familiar': `- Parc infantil proper a l'allotjament
- Restaurant amb menú infantil: "La Família Feliç"
- Hotel amb piscina i zona de jocs
- Visita al museu interactiu (perfecte per nens)`,
      'family': `- Parc infantil proper a l'allotjament
- Restaurant amb menú infantil: "La Família Feliç"
- Hotel amb piscina i zona de jocs
- Visita al museu interactiu (perfecte per nens)`,
      'pareja': `- Sopar romàntic: Restaurant "El Mirador" amb vistes
- Hotel boutique amb spa
- Passeig al vespre pel casc antic
- Celler local per a tast de vins`,
      'couple': `- Sopar romàntic: Restaurant "El Mirador" amb vistes
- Hotel boutique amb spa
- Passeig al vespre pel casc antic
- Celler local per a tast de vins`,
      'aventura': `- Ruta de senderisme de 15km (dificultat mitjana)
- Lloguer de kayaks al riu local
- Càmping sota les estrelles (opcional)
- Escalada en roca per a principiants`,
      'adventure': `- Ruta de senderisme de 15km (dificultat mitjana)
- Lloguer de kayaks al riu local
- Càmping sota les estrelles (opcional)
- Escalada en roca per a principiants`,
      'moto': `- Carretera panoràmica N-XXX (corbes perfectes)
- Parada tècnica: Taller "Moto Service" (km 45)
- Hostal moter "La Corba" (descompte per a moters)
- Ruta alternativa per port de muntanya (+30min, espectacular)`,
      'motorcycle': `- Carretera panoràmica N-XXX (corbes perfectes)
- Parada tècnica: Taller "Moto Service" (km 45)
- Hostal moter "La Corba" (descompte per a moters)
- Ruta alternativa per port de muntanya (+30min, espectacular)`
    },
    fr: {
      'famille': `- Aire de jeux près de l'hébergement
- Restaurant avec menu enfant: "La Famille Heureuse"
- Hôtel avec piscine et aire de jeux
- Visite du musée interactif (parfait pour les enfants)`,
      'family': `- Aire de jeux près de l'hébergement
- Restaurant avec menu enfant: "La Famille Heureuse"
- Hôtel avec piscine et aire de jeux
- Visite du musée interactif (parfait pour les enfants)`,
      'familiar': `- Aire de jeux près de l'hébergement
- Restaurant avec menu enfant: "La Famille Heureuse"
- Hôtel avec piscine et aire de jeux
- Visite du musée interactif (parfait pour les enfants)`,
      'couple': `- Dîner romantique: Restaurant "Le Belvédère" avec vue
- Hôtel boutique avec spa
- Promenade au coucher du soleil dans la vieille ville
- Cave locale pour dégustation de vins`,
      'pareja': `- Dîner romantique: Restaurant "Le Belvédère" avec vue
- Hôtel boutique avec spa
- Promenade au coucher du soleil dans la vieille ville
- Cave locale pour dégustation de vins`,
      'aventure': `- Randonnée de 15km (difficulté moyenne)
- Location de kayaks sur la rivière locale
- Camping sous les étoiles (facultatif)
- Escalade pour débutants`,
      'adventure': `- Randonnée de 15km (difficulté moyenne)
- Location de kayaks sur la rivière locale
- Camping sous les étoiles (facultatif)
- Escalade pour débutants`,
      'moto': `- Route panoramique N-XXX (virages parfaits)
- Arrêt technique: Atelier "Moto Service" (km 45)
- Auberge pour motards "La Courbe" (réduction pour motards)
- Route alternative par col de montagne (+30min, spectaculaire)`,
      'motorcycle': `- Route panoramique N-XXX (virages parfaits)
- Arrêt technique: Atelier "Moto Service" (km 45)
- Auberge pour motards "La Courbe" (réduction pour motards)
- Route alternative par col de montagne (+30min, spectaculaire)`
    },
    zh: {
      '家庭': `- 住宿附近的游乐场
- 儿童友好餐厅："快乐家庭"
- 带游泳池和游乐区的酒店
- 参观互动博物馆（非常适合儿童）`,
      'family': `- 住宿附近的游乐场
- 儿童友好餐厅："快乐家庭"
- 带游泳池和游乐区的酒店
- 参观互动博物馆（非常适合儿童）`,
      'familiar': `- 住宿附近的游乐场
- 儿童友好餐厅："快乐家庭"
- 带游泳池和游乐区的酒店
- 参观互动博物馆（非常适合儿童）`,
      '情侣': `- 浪漫晚餐："观景台"餐厅，景观优美
- 带水疗中心的精品酒店
- 日落时分漫步老城区
- 当地酒庄品酒`,
      'couple': `- 浪漫晚餐："观景台"餐厅，景观优美
- 带水疗中心的精品酒店
- 日落时分漫步老城区
- 当地酒庄品酒`,
      'pareja': `- 浪漫晚餐："观景台"餐厅，景观优美
- 带水疗中心的精品酒店
- 日落时分漫步老城区
- 当地酒庄品酒`,
      '冒险': `- 15公里徒步路线（中等难度）
- 在当地河流租用皮划艇
- 在星空下露营（可选）
- 初学者攀岩`,
      'adventure': `- 15公里徒步路线（中等难度）
- 在当地河流租用皮划艇
- 在星空下露营（可选）
- 初学者攀岩`,
      'aventura': `- 15公里徒步路线（中等难度）
- 在当地河流租用皮划艇
- 在星空下露营（可选）
- 初学者攀岩`,
      '摩托车': `- 风景优美的N-XXX公路（完美的弯道）
- 技术停靠点："摩托服务"车间（45公里处）
- 摩托车旅馆"La Curva"（摩托车手折扣）
- 山口替代路线（+30分钟，壮观）`,
      'motorcycle': `- 风景优美的N-XXX公路（完美的弯道）
- 技术停靠点："摩托服务"车间（45公里处）
- 摩托车旅馆"La Curva"（摩托车手折扣）
- 山口替代路线（+30分钟，壮观）`,
      'moto': `- 风景优美的N-XXX公路（完美的弯道）
- 技术停靠点："摩托服务"车间（45公里处）
- 摩托车旅馆"La Curva"（摩托车手折扣）
- 山口替代路线（+30分钟，壮观）`
    }
  };
  
  const langSugerencias = sugerencias[language] || sugerencias['es'];
  return langSugerencias[tipo] || langSugerencias['familiar'] || langSugerencias['family'];
}
