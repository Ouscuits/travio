/* ── Internationalization ── */
const TRANSLATIONS = {
    es: {
        app:  { name: 'Travio', tagline: 'Tu companero de viaje', subtitle: 'Planifica, optimiza y disfruta cada kilometro' },
        login: { title: 'Iniciar Sesion', email: 'Correo electronico', password: 'Contrasena', signIn: 'Entrar', signingIn: 'Entrando...', errorRequired: 'Introduce email y contrasena', errorInvalid: 'Email o contrasena incorrectos', errorNoAccount: 'Cuenta no configurada' },
        nav:  { logout: 'Cerrar sesion', admin: 'Admin', savedRoutes: 'Mis Rutas', newRoute: 'Nueva Ruta', welcome: 'Hola' },
        form: {
            title: 'Datos del Viaje',
            startPoint: 'Punto de partida', startPointPh: 'ej: Madrid',
            endPoint: 'Punto final', endPointPh: 'ej: Madrid (viaje circular)',
            destinations: 'Destinos a visitar', destinationsHint: '(separados por comas)', destinationsPh: 'ej: Santiago, Finisterre, A Coruna',
            tripType: 'Tipo de viaje',
            family: 'Familiar', couple: 'En pareja', adventure: 'Aventura', motorcycle: 'En moto',
            duration: 'Duracion (dias)', dailyBudget: 'Presupuesto diario (EUR)',
            advancedOptions: 'Opciones avanzadas', customizeBudget: 'Personalizar presupuesto por dia', day: 'Dia',
            tollPreference: 'Preferencia de peajes', withTolls: 'Con peajes (mas rapido)', withoutTolls: 'Sin peajes (economico/escenico)',
            departureTime: 'Hora de salida',
            costAssumptions: 'Supuestos de coste',
            consumption: 'Consumo (L/100 km)', fuelPrice: 'Precio del combustible (EUR/L)',
            lodgingPerNight: 'Alojamiento por noche (EUR)', mealsPerDay: 'Comidas por dia (EUR)',
            generate: 'Generar Ruta con IA', generating: 'Creando tu ruta perfecta...', clear: 'Limpiar',
            required: 'Completa todos los campos obligatorios'
        },
        tripTypeLabel: { familiar: 'familiar', pareja: 'en pareja', aventura: 'aventura', moto: 'en moto' },
        result: {
            title: 'Resultado', saveRoute: 'Guardar Ruta', routeSaved: 'Ruta guardada',
            emptyState: 'Completa el formulario y genera tu ruta para ver los resultados aqui',
            analyzing: 'Analizando la mejor ruta para tu viaje...', waitTime: 'Esto puede tardar 15-30 segundos',
            route: 'Ruta', days: 'dias', budget: 'Presupuesto', error: 'Error al generar la ruta'
        },
        unit: { hour: 'h', minute: 'min', km: 'km' },
        progress: {
            geocoding: 'Localizando lugares en el mapa',
            geocodingItem: '{done}/{total} - {name}',
            geocodedAs: '{name}: localizado en {label}',
            matrix: 'Midiendo distancias reales por carretera',
            planning: 'Optimizando la ruta y repartiendo los dias',
            mapping: 'Trazando la ruta en el mapa',
            enriching: 'Anadiendo recomendaciones locales',
            done: 'Itinerario listo',
            ratePolicy: 'El servicio de mapas permite una consulta por segundo, asi que esto tarda unos segundos.'
        },
        itin: {
            summary: 'Resumen del viaje',
            totalKm: 'Distancia total', totalTime: 'Tiempo total de conduccion',
            totalCost: 'Coste estimado', totalBudget: 'Presupuesto total',
            overBudgetBy: 'Excede el presupuesto en {amount}', underBudgetBy: 'Quedan {amount} de presupuesto',
            sourceRoad: 'Distancias y tiempos de la red real de carreteras (OSRM)',
            sourceEstimated: 'Distancias estimadas desde coordenadas (sin datos de carretera)',
            sourcePartial: 'Datos de carretera parciales: algunos tramos son estimaciones en linea recta',
            dayN: 'Dia {day}', distance: 'Distancia', driveTime: 'Conduccion',
            departureArrival: 'Salida / llegada', arriveAt: 'llegada {time}',
            overnight: 'Noche en {place}', stops: 'Paradas',
            restDay: 'Dia de descanso', restDayAt: 'Descanso o exploracion en {place}: sin conduccion prevista.',
            longDay: 'Jornada larga',
            fuel: 'Combustible', tolls: 'Peajes', lodging: 'Alojamiento', meals: 'Comidas',
            total: 'Total del dia', budget: 'Presupuesto del dia',
            withinBudget: 'Dentro del presupuesto', estimate: '(estimado)',
            unknownValue: '—', tollsNotEstimated: '(sin estimar)', tollsNotApplicable: '(no aplicable)',
            tollsCapped: '(estimacion limitada)', tollsNoDriving: '(sin conduccion)',
            atLeast: 'al menos {amount}',
            overBudgetByWithEstimate: 'Excede el presupuesto en {amount}, cifra que incluye {tolls} de peajes estimados por la IA',
            withinBudgetIncomplete: 'Dentro del presupuesto en lo contabilizado; el total no esta completo',
            budgetNotAssessable: 'No se puede valorar el presupuesto: las distancias de arriba no son utilizables',
            overBudgetByEstimated: 'Excede el presupuesto en {amount}, pero solo por el peaje estimado por la IA ({tolls})',
            activities: 'Actividades', mealsIdeas: 'Donde comer',
            meal_breakfast: 'Desayuno', meal_lunch: 'Comida', meal_dinner: 'Cena',
            meal_other: 'Para comer',
            lodgingIdea: 'Donde dormir', tip: 'Consejo local',
            enrichUnavailable: 'Las recomendaciones locales no estan disponibles ahora. La ruta, los dias, las distancias y los tiempos de abajo estan calculados y no dependen de ellas. Los costes solo incluyen los conceptos que aparecen en la tabla de cada dia.',
            enrichPartial: 'Sin recomendaciones para el/los dia(s) {days}. El itinerario calculado no se ve afectado.',
            ratesNote: 'Combustible {consumption} L/100 km a EUR {price}/L - alojamiento EUR {lodging}/noche - comidas EUR {meals}/dia',
            geoTitle: 'Donde se ha localizado cada lugar',
            geoNote: 'Estas etiquetas vienen del geocodificador de OpenStreetMap, no de Travio. Si alguna no es el lugar que querias, escribe el nombre con mas precision (anade la comarca, la provincia o el pais) y genera la ruta otra vez.',
            geoNotLocated: 'no se ha podido localizar',
            geoNoLabel: 'el geocodificador no ha devuelto ninguna etiqueta',
            geoBadgeOutlier: 'a {km} del resto del viaje',
            geoBadgeOutlierFar: 'muy lejos del resto del viaje',
            geoBadgeMatches: '{count} lugares coinciden con este nombre',
            geoBadgeMoved: 'no era la primera coincidencia: elegido por estar mas cerca del resto del viaje'
        },
        notice: {
            geoOutlier: '"{name}" se ha localizado en {label}, a {km} del resto del viaje. Si no es el lugar que querias, las distancias, los tiempos y los costes de abajo son los de un viaje que no has pedido.',
            geoOutlierNoDistance: '"{name}" se ha localizado en {label}, muy lejos del resto del viaje. Si no es el lugar que querias, las distancias, los tiempos y los costes de abajo son los de un viaje que no has pedido.',
            geoRelocated: '"{name}" coincidia con mas de un lugar. Se ha usado {label}, elegido por estar mas cerca del resto del viaje y no por ser la primera coincidencia del geocodificador. Si querias otro, escribe el nombre con mas precision.',
            geoAmbiguous: '{count} de los nombres que has escrito coinciden con mas de un lugar ({names}). La lista de arriba muestra cual se ha usado en cada caso.',
            restDay: 'Dia {day}: sin conduccion, descanso o exploracion en {place}.',
            overCap: 'El dia {day} conduce {drive}, por encima del limite diario de {cap}.',
            duplicate: '"{name}" aparecia repetido; se visita una sola vez.',
            sameAsStart: '"{name}" ya es el punto de partida; no se anade como parada.',
            sameAsEnd: '"{name}" ya es el punto final; no se anade como parada.',
            unresolved: 'No se ha podido localizar "{name}" en el mapa; sus distancias son aproximadas.',
            haversine: 'Sin datos de carretera: distancias y tiempos estimados en linea recta.',
            mixed: 'Datos de carretera parciales: {filled} de {total} distancias son estimaciones en linea recta (tramos sin ruta por carretera), no distancias reales de conduccion.',
            mixedUnknownCount: 'Datos de carretera parciales: algunas distancias son estimaciones en linea recta, no distancias reales de conduccion.',
            zeroDistance: 'El itinerario completo suma 0 km: las coordenadas o la matriz de distancias no son utilizables, asi que las cifras de abajo no son reales.',
            unknownDistance: 'Al menos un tramo no tiene datos de distancia utilizables y se cuenta como 0 km: las distancias, los tiempos y los costes de abajo estan incompletos.',
            tollsUnknown: 'No se han podido estimar los peajes, asi que no se incluyen en ningun total: las cifras de abajo son un minimo, no el coste completo.',
            tollsNotAvoided: 'Has pedido evitar peajes, pero la ruta de abajo NO se ha recalculado para evitarlos: las distancias y los tiempos son los de la ruta mas rapida, que puede usar autopistas de pago. Por eso los peajes figuran como no aplicables y no como cero, y el coste mostrado es un minimo.',
            tollsClamped: 'La IA estimo EUR {value} de peajes el dia {day}, una cifra inverosimil para {km}; se ha limitado a EUR {capped}.',
            roundTrip: 'Viaje circular: el itinerario vuelve a {place}.',
            overBudget: 'Presupuesto excedido el/los dia(s) {days}.'
        },
        map: {
            title: 'Mapa de la ruta',
            noRoute: 'Todavia no hay ruta que dibujar',
            sourceRoad: 'Linea trazada sobre la red real de carreteras (OSRM)',
            sourceStraight: 'Lineas rectas entre paradas: una estimacion, no la carretera',
            straightLineNote: 'Estimacion: lineas rectas, no el trazado real',
            dayLabel: 'Dia {day}: {from} → {to}',
            legend: 'Dia {day}',
            straightNotice: 'El mapa dibuja lineas rectas entre las paradas porque no se ha podido obtener el trazado por carretera: la linea es una estimacion de la forma del viaje, no el camino que conduciras. Las distancias y los tiempos de arriba no cambian.',
            savedNoGeometry: 'Esta ruta guardada no incluye el trazado por carretera, asi que el mapa dibuja lineas rectas entre las paradas: una estimacion de la forma del viaje, no el camino que conduciras. Las distancias y los tiempos de arriba no cambian.'
        },
        exp: {
            title: 'Exportar', gpx: 'GPX', ics: 'Calendario', print: 'Imprimir / PDF',
            startDate: 'Fecha de inicio del viaje',
            needDate: 'Elige la fecha de inicio del viaje para exportar el calendario',
            trip: 'Ruta de Travio',
            start: 'Inicio', end: 'Final', stop: 'Parada', overnight: 'Noche',
            restDayAt: 'Dia de descanso en {place}',
            cost: 'Coste estimado: {amount}',
            costFloor: 'Coste estimado: al menos {amount} (incompleto: hay costes desconocidos)',
            suggestions: 'Sugerencias (generadas por IA, no forman parte de la ruta calculada)',
            viaPoints: 'Puntos de paso previstos. Las lineas rectas entre ellos NO son el trazado por carretera.',
            roadTrack: 'Trazado obtenido del servicio de rutas por carretera.',
            unlocated: 'No se han podido localizar {count} lugar(es) y no aparecen en este archivo.',
            longDay: 'Jornada larga: {drive}, por encima del limite de {cap} que se dio al planificador.',
            longDayNoCap: 'Jornada larga: por encima del limite diario que se dio al planificador.',
            plannerNotes: 'Notas del planificador',
            unreliable: 'No se han podido calcular las distancias ni los tiempos de este viaje y se omiten.',
            notAvailable: 'no disponible',
            atLeast: 'al menos {value}'
        },
        routes: {
            title: 'Mis Rutas Guardadas', noRoutes: 'No tienes rutas guardadas',
            load: 'Ver', delete: 'Eliminar', confirmDelete: 'Eliminar esta ruta?',
            back: 'Volver'
        },
        admin: {
            title: 'Panel de Administracion', users: 'Usuarios',
            createUser: 'Crear Usuario', editUser: 'Editar Usuario',
            name: 'Nombre', email: 'Email', password: 'Contrasena', role: 'Rol',
            roleAdmin: 'Administrador', roleUser: 'Usuario', language: 'Idioma',
            save: 'Guardar', cancel: 'Cancelar', delete: 'Eliminar',
            confirmDelete: 'Eliminar este usuario?', resetPwd: 'Restablecer contrasena',
            back: 'Volver', created: 'Usuario creado', updated: 'Usuario actualizado', deleted: 'Usuario eliminado'
        },
        footer: { credit: 'Creado con amor por Travio', tagline: 'Tu companero inteligente de viajes' },
        common: { save: 'Guardar', cancel: 'Cancelar', delete: 'Eliminar', confirm: 'Confirmar', error: 'Error', success: 'Exito', loading: 'Cargando...' }
    },
    en: {
        app:  { name: 'Travio', tagline: 'Your trip mate', subtitle: 'Plan, optimize and enjoy every kilometer' },
        login: { title: 'Sign In', email: 'Email', password: 'Password', signIn: 'Sign In', signingIn: 'Signing in...', errorRequired: 'Enter email and password', errorInvalid: 'Invalid email or password', errorNoAccount: 'Account not configured' },
        nav:  { logout: 'Sign out', admin: 'Admin', savedRoutes: 'My Routes', newRoute: 'New Route', welcome: 'Hello' },
        form: {
            title: 'Travel Data',
            startPoint: 'Starting point', startPointPh: 'e.g: London',
            endPoint: 'End point', endPointPh: 'e.g: London (round trip)',
            destinations: 'Destinations to visit', destinationsHint: '(comma separated)', destinationsPh: 'e.g: Edinburgh, Glasgow, Inverness',
            tripType: 'Trip type',
            family: 'Family', couple: 'Couple', adventure: 'Adventure', motorcycle: 'Motorcycle',
            duration: 'Duration (days)', dailyBudget: 'Daily budget (EUR)',
            advancedOptions: 'Advanced options', customizeBudget: 'Customize budget per day', day: 'Day',
            tollPreference: 'Toll preference', withTolls: 'With tolls (faster)', withoutTolls: 'Without tolls (scenic/economical)',
            departureTime: 'Departure time',
            costAssumptions: 'Cost assumptions',
            consumption: 'Fuel consumption (L/100 km)', fuelPrice: 'Fuel price (EUR/L)',
            lodgingPerNight: 'Lodging per night (EUR)', mealsPerDay: 'Meals per day (EUR)',
            generate: 'Generate Route with AI', generating: 'Creating your perfect route...', clear: 'Clear',
            required: 'Please fill all required fields'
        },
        tripTypeLabel: { familiar: 'family', pareja: 'couple', aventura: 'adventure', moto: 'motorcycle' },
        result: {
            title: 'Result', saveRoute: 'Save Route', routeSaved: 'Route saved',
            emptyState: 'Fill out the form and generate your route to see results here',
            analyzing: 'Analyzing the best route for your trip...', waitTime: 'This may take 15-30 seconds',
            route: 'Route', days: 'days', budget: 'Budget', error: 'Error generating route'
        },
        unit: { hour: 'h', minute: 'min', km: 'km' },
        progress: {
            geocoding: 'Locating places on the map',
            geocodingItem: '{done}/{total} - {name}',
            geocodedAs: '{name}: located at {label}',
            matrix: 'Measuring real road distances',
            planning: 'Optimising the route and splitting the days',
            mapping: 'Drawing the route on the map',
            enriching: 'Adding local recommendations',
            done: 'Itinerary ready',
            ratePolicy: 'The map service allows one lookup per second, so this takes a few seconds.'
        },
        itin: {
            summary: 'Trip summary',
            totalKm: 'Total distance', totalTime: 'Total drive time',
            totalCost: 'Estimated cost', totalBudget: 'Total budget',
            overBudgetBy: 'Over budget by {amount}', underBudgetBy: '{amount} left in budget',
            sourceRoad: 'Distances and times from the real road network (OSRM)',
            sourceEstimated: 'Distances estimated from coordinates (no road data)',
            sourcePartial: 'Partial road data: some legs are straight-line estimates',
            dayN: 'Day {day}', distance: 'Distance', driveTime: 'Drive time',
            departureArrival: 'Departure / arrival', arriveAt: 'arrive {time}',
            overnight: 'Overnight in {place}', stops: 'Stops',
            restDay: 'Rest day', restDayAt: 'Rest or explore {place}: no driving planned.',
            longDay: 'Long drive',
            fuel: 'Fuel', tolls: 'Tolls', lodging: 'Lodging', meals: 'Meals',
            total: 'Day total', budget: 'Day budget',
            withinBudget: 'Within budget', estimate: '(estimate)',
            unknownValue: '—', tollsNotEstimated: '(not estimated)', tollsNotApplicable: '(not applicable)',
            tollsCapped: '(estimate, capped)', tollsNoDriving: '(no driving)',
            atLeast: 'at least {amount}',
            overBudgetByWithEstimate: 'Over budget by {amount}, a figure that includes {tolls} of AI-estimated tolls',
            withinBudgetIncomplete: 'Within budget for what is counted; the total is not complete',
            budgetNotAssessable: 'The budget cannot be assessed: the distances above are not usable',
            overBudgetByEstimated: 'Over budget by {amount}, but only because of the AI-estimated toll ({tolls})',
            activities: 'Activities', mealsIdeas: 'Where to eat',
            meal_breakfast: 'Breakfast', meal_lunch: 'Lunch', meal_dinner: 'Dinner',
            meal_other: 'Where to eat',
            lodgingIdea: 'Where to sleep', tip: 'Local tip',
            enrichUnavailable: 'Local recommendations are not available right now. The route, days, distances and times below are computed and do not depend on them. Costs cover only the items listed in each day\'s table.',
            enrichPartial: 'No recommendations for day(s) {days}. The computed itinerary is unaffected.',
            ratesNote: 'Fuel {consumption} L/100 km at EUR {price}/L - lodging EUR {lodging}/night - meals EUR {meals}/day',
            geoTitle: 'Where each place was located',
            geoNote: 'These labels come from the OpenStreetMap geocoder, not from Travio. If one of them is not the place you meant, write the name more precisely (add the region, province or country) and generate the route again.',
            geoNotLocated: 'could not be located',
            geoNoLabel: 'the geocoder returned no label',
            geoBadgeOutlier: '{km} from the rest of the trip',
            geoBadgeOutlierFar: 'far from the rest of the trip',
            geoBadgeMatches: '{count} places matched this name',
            geoBadgeMoved: 'not the first match: chosen for being nearer the rest of the trip'
        },
        notice: {
            geoOutlier: '"{name}" was located at {label}, {km} from the rest of the trip. If that is not the place you meant, the distances, times and costs below are for a journey you did not ask for.',
            geoOutlierNoDistance: '"{name}" was located at {label}, far from the rest of the trip. If that is not the place you meant, the distances, times and costs below are for a journey you did not ask for.',
            geoRelocated: '"{name}" matched more than one place. {label} was used, chosen for being nearer the rest of the trip rather than because it was the geocoder\'s first result. If you meant a different one, write the name more precisely.',
            geoAmbiguous: '{count} of the names you typed matched more than one place ({names}). The list above shows exactly which one was used for each.',
            restDay: 'Day {day}: no driving, rest or explore {place}.',
            overCap: 'Day {day} drives {drive}, over the {cap} daily limit.',
            duplicate: '"{name}" was listed more than once; it is visited once.',
            sameAsStart: '"{name}" is already the starting point; it was not added as a stop.',
            sameAsEnd: '"{name}" is already the end point; it was not added as a stop.',
            unresolved: '"{name}" could not be located on the map; its distances are approximate.',
            haversine: 'No road data available: distances and times are straight-line estimates.',
            mixed: 'Partial road data: {filled} of {total} distances are straight-line estimates (pairs with no drivable route), not driving distances.',
            mixedUnknownCount: 'Partial road data: some distances are straight-line estimates, not driving distances.',
            zeroDistance: 'The whole itinerary computes to 0 km: the coordinates or the distance matrix are unusable, so the figures below are not real.',
            unknownDistance: 'At least one leg has no usable distance data and is counted as 0 km: the distances, times and costs below are incomplete.',
            tollsUnknown: 'Tolls could not be estimated, so they are not included in any total: the figures below are a minimum, not the full cost.',
            tollsNotAvoided: 'You asked to avoid tolls, but the route below has NOT been re-planned to avoid them: the distances and times are those of the fastest route, which may use toll roads. Tolls are therefore shown as not applicable rather than zero, and the cost shown is a minimum.',
            tollsClamped: 'The AI estimated EUR {value} of tolls on day {day}, which is not plausible for {km}; it has been capped at EUR {capped}.',
            roundTrip: 'Round trip: the itinerary returns to {place}.',
            overBudget: 'Over budget on day(s) {days}.'
        },
        map: {
            title: 'Route map',
            noRoute: 'No route to draw yet',
            sourceRoad: 'Line drawn from the real road network (OSRM)',
            sourceStraight: 'Straight lines between stops: an estimate, not the road',
            straightLineNote: 'Estimate: straight lines, not the real road route',
            dayLabel: 'Day {day}: {from} → {to}',
            legend: 'Day {day}',
            straightNotice: 'The map draws straight lines between the stops because no road geometry could be obtained: the line is an estimate of the shape of the journey, not the route you will drive. The distances and times above are unaffected.',
            savedNoGeometry: 'This saved route carries no road geometry, so the map draws straight lines between the stops: an estimate of the shape of the journey, not the route you will drive. The distances and times above are unaffected.'
        },
        exp: {
            title: 'Export', gpx: 'GPX', ics: 'Calendar', print: 'Print / PDF',
            startDate: 'Trip start date',
            needDate: 'Choose the trip start date to export a calendar',
            trip: 'Travio route',
            start: 'Start', end: 'End', stop: 'Stop', overnight: 'Overnight',
            restDayAt: 'Rest day in {place}',
            cost: 'Estimated cost: {amount}',
            costFloor: 'Estimated cost: at least {amount} (incomplete — some costs are unknown)',
            suggestions: 'Suggestions (AI-generated, not part of the computed route)',
            viaPoints: 'Planned via points. Straight lines between them are NOT the road route.',
            roadTrack: 'Track from the routing service road geometry.',
            unlocated: '{count} place(s) could not be located and are omitted from this file.',
            longDay: 'Long driving day: {drive}, above the {cap} the planner was given.',
            longDayNoCap: 'Long driving day: above the daily limit the planner was given.',
            plannerNotes: 'Planner notes',
            unreliable: 'Distances and times could not be computed for this trip and are omitted.',
            notAvailable: 'not available',
            atLeast: 'at least {value}'
        },
        routes: {
            title: 'My Saved Routes', noRoutes: 'You have no saved routes',
            load: 'View', delete: 'Delete', confirmDelete: 'Delete this route?',
            back: 'Back'
        },
        admin: {
            title: 'Administration Panel', users: 'Users',
            createUser: 'Create User', editUser: 'Edit User',
            name: 'Name', email: 'Email', password: 'Password', role: 'Role',
            roleAdmin: 'Administrator', roleUser: 'User', language: 'Language',
            save: 'Save', cancel: 'Cancel', delete: 'Delete',
            confirmDelete: 'Delete this user?', resetPwd: 'Reset password',
            back: 'Back', created: 'User created', updated: 'User updated', deleted: 'User deleted'
        },
        footer: { credit: 'Made with love by Travio', tagline: 'Your intelligent travel companion' },
        common: { save: 'Save', cancel: 'Cancel', delete: 'Delete', confirm: 'Confirm', error: 'Error', success: 'Success', loading: 'Loading...' }
    },
    ca: {
        app:  { name: 'Travio', tagline: 'El teu company de viatge', subtitle: 'Planifica, optimitza i gaudeix de cada quilometre' },
        login: { title: 'Iniciar Sessio', email: 'Correu electronic', password: 'Contrasenya', signIn: 'Entrar', signingIn: 'Entrant...', errorRequired: 'Introdueix email i contrasenya', errorInvalid: 'Email o contrasenya incorrectes', errorNoAccount: 'Compte no configurat' },
        nav:  { logout: 'Tancar sessio', admin: 'Admin', savedRoutes: 'Les Meves Rutes', newRoute: 'Nova Ruta', welcome: 'Hola' },
        form: {
            title: 'Dades del Viatge',
            startPoint: 'Punt de partida', startPointPh: 'ex: Barcelona',
            endPoint: 'Punt final', endPointPh: 'ex: Barcelona (viatge circular)',
            destinations: 'Destinacions a visitar', destinationsHint: '(separades per comes)', destinationsPh: 'ex: Girona, Figueres, Cadaques',
            tripType: 'Tipus de viatge',
            family: 'Familiar', couple: 'En parella', adventure: 'Aventura', motorcycle: 'En moto',
            duration: 'Durada (dies)', dailyBudget: 'Pressupost diari (EUR)',
            advancedOptions: 'Opcions avancades', customizeBudget: 'Personalitzar pressupost per dia', day: 'Dia',
            tollPreference: 'Preferencia de peatges', withTolls: 'Amb peatges (mes rapid)', withoutTolls: 'Sense peatges (economic/escenic)',
            departureTime: 'Hora de sortida',
            costAssumptions: 'Supostos de cost',
            consumption: 'Consum (L/100 km)', fuelPrice: 'Preu del combustible (EUR/L)',
            lodgingPerNight: 'Allotjament per nit (EUR)', mealsPerDay: 'Apats per dia (EUR)',
            generate: 'Generar Ruta amb IA', generating: 'Creant la teva ruta perfecta...', clear: 'Netejar',
            required: 'Completa tots els camps obligatoris'
        },
        tripTypeLabel: { familiar: 'familiar', pareja: 'en parella', aventura: 'aventura', moto: 'en moto' },
        result: {
            title: 'Resultat', saveRoute: 'Guardar Ruta', routeSaved: 'Ruta guardada',
            emptyState: 'Completa el formulari i genera la teva ruta per veure els resultats aqui',
            analyzing: 'Analitzant la millor ruta pel teu viatge...', waitTime: 'Aixo pot trigar 15-30 segons',
            route: 'Ruta', days: 'dies', budget: 'Pressupost', error: 'Error al generar la ruta'
        },
        unit: { hour: 'h', minute: 'min', km: 'km' },
        progress: {
            geocoding: 'Localitzant llocs al mapa',
            geocodingItem: '{done}/{total} - {name}',
            geocodedAs: '{name}: localitzat a {label}',
            matrix: 'Mesurant distancies reals per carretera',
            planning: 'Optimitzant la ruta i repartint els dies',
            mapping: 'Dibuixant la ruta al mapa',
            enriching: 'Afegint recomanacions locals',
            done: 'Itinerari a punt',
            ratePolicy: 'El servei de mapes permet una consulta per segon, per aixo triga uns segons.'
        },
        itin: {
            summary: 'Resum del viatge',
            totalKm: 'Distancia total', totalTime: 'Temps total de conduccio',
            totalCost: 'Cost estimat', totalBudget: 'Pressupost total',
            overBudgetBy: 'Supera el pressupost en {amount}', underBudgetBy: 'Queden {amount} de pressupost',
            sourceRoad: 'Distancies i temps de la xarxa real de carreteres (OSRM)',
            sourceEstimated: 'Distancies estimades des de coordenades (sense dades de carretera)',
            sourcePartial: 'Dades de carretera parcials: alguns trams son estimacions en linia recta',
            dayN: 'Dia {day}', distance: 'Distancia', driveTime: 'Conduccio',
            departureArrival: 'Sortida / arribada', arriveAt: 'arribada {time}',
            overnight: 'Nit a {place}', stops: 'Parades',
            restDay: 'Dia de descans', restDayAt: 'Descans o exploracio a {place}: sense conduccio prevista.',
            longDay: 'Jornada llarga',
            fuel: 'Combustible', tolls: 'Peatges', lodging: 'Allotjament', meals: 'Apats',
            total: 'Total del dia', budget: 'Pressupost del dia',
            withinBudget: 'Dins del pressupost', estimate: '(estimat)',
            unknownValue: '—', tollsNotEstimated: '(sense estimar)', tollsNotApplicable: '(no aplicable)',
            tollsCapped: '(estimacio limitada)', tollsNoDriving: '(sense conduccio)',
            atLeast: 'com a minim {amount}',
            overBudgetByWithEstimate: 'Supera el pressupost en {amount}, xifra que inclou {tolls} de peatges estimats per la IA',
            withinBudgetIncomplete: 'Dins del pressupost pel que s\'ha comptat; el total no es complet',
            budgetNotAssessable: 'No es pot valorar el pressupost: les distancies de sobre no son utilitzables',
            overBudgetByEstimated: 'Supera el pressupost en {amount}, pero nomes pel peatge estimat per la IA ({tolls})',
            activities: 'Activitats', mealsIdeas: 'On menjar',
            meal_breakfast: 'Esmorzar', meal_lunch: 'Dinar', meal_dinner: 'Sopar',
            meal_other: 'Per menjar',
            lodgingIdea: 'On dormir', tip: 'Consell local',
            enrichUnavailable: 'Les recomanacions locals no estan disponibles ara. La ruta, els dies, les distancies i els temps de sota estan calculats i no en depenen. Els costos nomes inclouen els conceptes que apareixen a la taula de cada dia.',
            enrichPartial: 'Sense recomanacions per al(s) dia(es) {days}. L\'itinerari calculat no queda afectat.',
            ratesNote: 'Combustible {consumption} L/100 km a EUR {price}/L - allotjament EUR {lodging}/nit - apats EUR {meals}/dia',
            geoTitle: 'On s\'ha localitzat cada lloc',
            geoNote: 'Aquestes etiquetes venen del geocodificador d\'OpenStreetMap, no de Travio. Si alguna no es el lloc que volies, escriu el nom amb mes precisio (afegeix la comarca, la provincia o el pais) i torna a generar la ruta.',
            geoNotLocated: 'no s\'ha pogut localitzar',
            geoNoLabel: 'el geocodificador no ha retornat cap etiqueta',
            geoBadgeOutlier: 'a {km} de la resta del viatge',
            geoBadgeOutlierFar: 'molt lluny de la resta del viatge',
            geoBadgeMatches: '{count} llocs coincideixen amb aquest nom',
            geoBadgeMoved: 'no era la primera coincidencia: triat per ser mes a prop de la resta del viatge'
        },
        notice: {
            geoOutlier: '"{name}" s\'ha localitzat a {label}, a {km} de la resta del viatge. Si no es el lloc que volies, les distancies, els temps i els costos de sota son els d\'un viatge que no has demanat.',
            geoOutlierNoDistance: '"{name}" s\'ha localitzat a {label}, molt lluny de la resta del viatge. Si no es el lloc que volies, les distancies, els temps i els costos de sota son els d\'un viatge que no has demanat.',
            geoRelocated: '"{name}" coincidia amb mes d\'un lloc. S\'ha usat {label}, triat per ser mes a prop de la resta del viatge i no per ser la primera coincidencia del geocodificador. Si en volies un altre, escriu el nom amb mes precisio.',
            geoAmbiguous: '{count} dels noms que has escrit coincideixen amb mes d\'un lloc ({names}). La llista de sobre mostra quin s\'ha usat en cada cas.',
            restDay: 'Dia {day}: sense conduccio, descans o exploracio a {place}.',
            overCap: 'El dia {day} condueix {drive}, per sobre del limit diari de {cap}.',
            duplicate: '"{name}" apareixia repetit; es visita una sola vegada.',
            sameAsStart: '"{name}" ja es el punt de partida; no s\'afegeix com a parada.',
            sameAsEnd: '"{name}" ja es el punt final; no s\'afegeix com a parada.',
            unresolved: 'No s\'ha pogut localitzar "{name}" al mapa; les seves distancies son aproximades.',
            haversine: 'Sense dades de carretera: distancies i temps estimats en linia recta.',
            mixed: 'Dades de carretera parcials: {filled} de {total} distancies son estimacions en linia recta (trams sense ruta per carretera), no distancies reals de conduccio.',
            mixedUnknownCount: 'Dades de carretera parcials: algunes distancies son estimacions en linia recta, no distancies reals de conduccio.',
            zeroDistance: 'L\'itinerari sencer suma 0 km: les coordenades o la matriu de distancies no son utilitzables, aixi que les xifres de sota no son reals.',
            unknownDistance: 'Almenys un tram no te dades de distancia utilitzables i es compta com a 0 km: les distancies, els temps i els costos de sota estan incomplets.',
            tollsUnknown: 'No s\'han pogut estimar els peatges, aixi que no s\'inclouen en cap total: les xifres de sota son un minim, no el cost complet.',
            tollsNotAvoided: 'Has demanat evitar peatges, pero la ruta de sota NO s\'ha recalculat per evitar-los: les distancies i els temps son els de la ruta mes rapida, que pot fer servir autopistes de pagament. Per aixo els peatges consten com a no aplicables i no com a zero, i el cost mostrat es un minim.',
            tollsClamped: 'La IA va estimar EUR {value} de peatges el dia {day}, una xifra inversemblant per a {km}; s\'ha limitat a EUR {capped}.',
            roundTrip: 'Viatge circular: l\'itinerari torna a {place}.',
            overBudget: 'Pressupost superat el(s) dia(es) {days}.'
        },
        map: {
            title: 'Mapa de la ruta',
            noRoute: 'Encara no hi ha ruta per dibuixar',
            sourceRoad: 'Linia tracada sobre la xarxa real de carreteres (OSRM)',
            sourceStraight: 'Linies rectes entre parades: una estimacio, no la carretera',
            straightLineNote: 'Estimacio: linies rectes, no el tracat real',
            dayLabel: 'Dia {day}: {from} → {to}',
            legend: 'Dia {day}',
            straightNotice: 'El mapa dibuixa linies rectes entre les parades perque no s\'ha pogut obtenir el tracat per carretera: la linia es una estimacio de la forma del viatge, no el cami que conduiras. Les distancies i els temps de sobre no canvien.',
            savedNoGeometry: 'Aquesta ruta guardada no inclou el tracat per carretera, aixi que el mapa dibuixa linies rectes entre les parades: una estimacio de la forma del viatge, no el cami que conduiras. Les distancies i els temps de sobre no canvien.'
        },
        exp: {
            title: 'Exportar', gpx: 'GPX', ics: 'Calendari', print: 'Imprimir / PDF',
            startDate: 'Data d\'inici del viatge',
            needDate: 'Tria la data d\'inici del viatge per exportar el calendari',
            trip: 'Ruta de Travio',
            start: 'Inici', end: 'Final', stop: 'Parada', overnight: 'Nit',
            restDayAt: 'Dia de descans a {place}',
            cost: 'Cost estimat: {amount}',
            costFloor: 'Cost estimat: com a minim {amount} (incomplet: hi ha costos desconeguts)',
            suggestions: 'Suggeriments (generats per IA, no formen part de la ruta calculada)',
            viaPoints: 'Punts de pas previstos. Les linies rectes entre ells NO son el tracat per carretera.',
            roadTrack: 'Tracat obtingut del servei de rutes per carretera.',
            unlocated: 'No s\'han pogut localitzar {count} lloc(s) i no apareixen en aquest fitxer.',
            longDay: 'Jornada llarga: {drive}, per sobre del limit de {cap} que es va donar al planificador.',
            longDayNoCap: 'Jornada llarga: per sobre del limit diari que es va donar al planificador.',
            plannerNotes: 'Notes del planificador',
            unreliable: 'No s\'han pogut calcular les distancies ni els temps d\'aquest viatge i s\'ometen.',
            notAvailable: 'no disponible',
            atLeast: 'com a minim {value}'
        },
        routes: {
            title: 'Les Meves Rutes Guardades', noRoutes: 'No tens rutes guardades',
            load: 'Veure', delete: 'Eliminar', confirmDelete: 'Eliminar aquesta ruta?',
            back: 'Tornar'
        },
        admin: {
            title: 'Panell d\'Administracio', users: 'Usuaris',
            createUser: 'Crear Usuari', editUser: 'Editar Usuari',
            name: 'Nom', email: 'Email', password: 'Contrasenya', role: 'Rol',
            roleAdmin: 'Administrador', roleUser: 'Usuari', language: 'Idioma',
            save: 'Guardar', cancel: 'Cancelar', delete: 'Eliminar',
            confirmDelete: 'Eliminar aquest usuari?', resetPwd: 'Restablir contrasenya',
            back: 'Tornar', created: 'Usuari creat', updated: 'Usuari actualitzat', deleted: 'Usuari eliminat'
        },
        footer: { credit: 'Creat amb amor per Travio', tagline: 'El teu company intelligent de viatges' },
        common: { save: 'Guardar', cancel: 'Cancelar', delete: 'Eliminar', confirm: 'Confirmar', error: 'Error', success: 'Exit', loading: 'Carregant...' }
    },
    fr: {
        app:  { name: 'Travio', tagline: 'Votre compagnon de voyage', subtitle: 'Planifiez, optimisez et profitez de chaque kilometre' },
        login: { title: 'Connexion', email: 'Email', password: 'Mot de passe', signIn: 'Se connecter', signingIn: 'Connexion...', errorRequired: 'Entrez email et mot de passe', errorInvalid: 'Email ou mot de passe invalide', errorNoAccount: 'Compte non configure' },
        nav:  { logout: 'Deconnexion', admin: 'Admin', savedRoutes: 'Mes Itineraires', newRoute: 'Nouvel Itineraire', welcome: 'Bonjour' },
        form: {
            title: 'Donnees du Voyage',
            startPoint: 'Point de depart', startPointPh: 'ex: Paris',
            endPoint: 'Point d\'arrivee', endPointPh: 'ex: Paris (voyage circulaire)',
            destinations: 'Destinations a visiter', destinationsHint: '(separees par des virgules)', destinationsPh: 'ex: Lyon, Marseille, Nice',
            tripType: 'Type de voyage',
            family: 'Famille', couple: 'Couple', adventure: 'Aventure', motorcycle: 'Moto',
            duration: 'Duree (jours)', dailyBudget: 'Budget quotidien (EUR)',
            advancedOptions: 'Options avancees', customizeBudget: 'Personnaliser le budget par jour', day: 'Jour',
            tollPreference: 'Preference de peages', withTolls: 'Avec peages (plus rapide)', withoutTolls: 'Sans peages (economique/panoramique)',
            departureTime: 'Heure de depart',
            costAssumptions: 'Hypotheses de cout',
            consumption: 'Consommation (L/100 km)', fuelPrice: 'Prix du carburant (EUR/L)',
            lodgingPerNight: 'Hebergement par nuit (EUR)', mealsPerDay: 'Repas par jour (EUR)',
            generate: 'Generer l\'Itineraire avec IA', generating: 'Creation de votre itineraire parfait...', clear: 'Effacer',
            required: 'Remplissez tous les champs obligatoires'
        },
        tripTypeLabel: { familiar: 'famille', pareja: 'couple', aventura: 'aventure', moto: 'moto' },
        result: {
            title: 'Resultat', saveRoute: 'Sauvegarder', routeSaved: 'Itineraire sauvegarde',
            emptyState: 'Remplissez le formulaire et generez votre itineraire pour voir les resultats ici',
            analyzing: 'Analyse du meilleur itineraire pour votre voyage...', waitTime: 'Cela peut prendre 15-30 secondes',
            route: 'Itineraire', days: 'jours', budget: 'Budget', error: 'Erreur lors de la generation'
        },
        unit: { hour: 'h', minute: 'min', km: 'km' },
        progress: {
            geocoding: 'Localisation des lieux sur la carte',
            geocodingItem: '{done}/{total} - {name}',
            geocodedAs: '{name} : localise a {label}',
            matrix: 'Mesure des distances routieres reelles',
            planning: 'Optimisation de l\'itineraire et repartition des jours',
            mapping: 'Trace de l\'itineraire sur la carte',
            enriching: 'Ajout des recommandations locales',
            done: 'Itineraire pret',
            ratePolicy: 'Le service de cartes autorise une requete par seconde, cela prend donc quelques secondes.'
        },
        itin: {
            summary: 'Resume du voyage',
            totalKm: 'Distance totale', totalTime: 'Temps de conduite total',
            totalCost: 'Cout estime', totalBudget: 'Budget total',
            overBudgetBy: 'Depasse le budget de {amount}', underBudgetBy: 'Il reste {amount} de budget',
            sourceRoad: 'Distances et durees du reseau routier reel (OSRM)',
            sourceEstimated: 'Distances estimees a partir des coordonnees (sans donnees routieres)',
            sourcePartial: 'Donnees routieres partielles : certains troncons sont estimes a vol d\'oiseau',
            dayN: 'Jour {day}', distance: 'Distance', driveTime: 'Conduite',
            departureArrival: 'Depart / arrivee', arriveAt: 'arrivee {time}',
            overnight: 'Nuit a {place}', stops: 'Etapes',
            restDay: 'Journee de repos', restDayAt: 'Repos ou decouverte de {place} : aucune conduite prevue.',
            longDay: 'Longue journee',
            fuel: 'Carburant', tolls: 'Peages', lodging: 'Hebergement', meals: 'Repas',
            total: 'Total du jour', budget: 'Budget du jour',
            withinBudget: 'Dans le budget', estimate: '(estimation)',
            unknownValue: '—', tollsNotEstimated: '(non estime)', tollsNotApplicable: '(non applicable)',
            tollsCapped: '(estimation plafonnee)', tollsNoDriving: '(sans conduite)',
            atLeast: 'au moins {amount}',
            overBudgetByWithEstimate: 'Depasse le budget de {amount}, un chiffre qui comprend {tolls} de peages estimes par l\'IA',
            withinBudgetIncomplete: 'Dans le budget pour ce qui est comptabilise ; le total n\'est pas complet',
            budgetNotAssessable: 'Le budget ne peut pas etre evalue : les distances ci-dessus sont inutilisables',
            overBudgetByEstimated: 'Depasse le budget de {amount}, mais uniquement a cause du peage estime par l\'IA ({tolls})',
            activities: 'Activites', mealsIdeas: 'Ou manger',
            meal_breakfast: 'Petit-dejeuner', meal_lunch: 'Dejeuner', meal_dinner: 'Diner',
            meal_other: 'Ou manger',
            lodgingIdea: 'Ou dormir', tip: 'Conseil local',
            enrichUnavailable: 'Les recommandations locales ne sont pas disponibles pour le moment. L\'itineraire, les jours, les distances et les durees ci-dessous sont calcules et n\'en dependent pas. Les couts ne couvrent que les postes listes dans le tableau de chaque jour.',
            enrichPartial: 'Aucune recommandation pour le(s) jour(s) {days}. L\'itineraire calcule reste inchange.',
            ratesNote: 'Carburant {consumption} L/100 km a EUR {price}/L - hebergement EUR {lodging}/nuit - repas EUR {meals}/jour',
            geoTitle: 'Ou chaque lieu a ete localise',
            geoNote: 'Ces libelles proviennent du geocodeur OpenStreetMap, pas de Travio. Si l\'un d\'eux n\'est pas le lieu que vous vouliez, ecrivez le nom plus precisement (ajoutez la region, le departement ou le pays) et generez de nouveau l\'itineraire.',
            geoNotLocated: 'n\'a pas pu etre localise',
            geoNoLabel: 'le geocodeur n\'a renvoye aucun libelle',
            geoBadgeOutlier: 'a {km} du reste du voyage',
            geoBadgeOutlierFar: 'tres loin du reste du voyage',
            geoBadgeMatches: '{count} lieux correspondent a ce nom',
            geoBadgeMoved: 'pas la premiere correspondance : choisi parce qu\'il est plus proche du reste du voyage'
        },
        notice: {
            geoOutlier: '"{name}" a ete localise a {label}, a {km} du reste du voyage. Si ce n\'est pas le lieu que vous vouliez, les distances, les durees et les couts ci-dessous sont ceux d\'un voyage que vous n\'avez pas demande.',
            geoOutlierNoDistance: '"{name}" a ete localise a {label}, tres loin du reste du voyage. Si ce n\'est pas le lieu que vous vouliez, les distances, les durees et les couts ci-dessous sont ceux d\'un voyage que vous n\'avez pas demande.',
            geoRelocated: '"{name}" correspondait a plusieurs lieux. {label} a ete retenu parce qu\'il est plus proche du reste du voyage, et non parce qu\'il etait le premier resultat du geocodeur. Si vous en vouliez un autre, ecrivez le nom plus precisement.',
            geoAmbiguous: '{count} des noms que vous avez saisis correspondent a plusieurs lieux ({names}). La liste ci-dessus indique lequel a ete retenu dans chaque cas.',
            restDay: 'Jour {day} : aucune conduite, repos ou decouverte de {place}.',
            overCap: 'Le jour {day} conduit {drive}, au-dela de la limite quotidienne de {cap}.',
            duplicate: '"{name}" apparaissait plusieurs fois ; il n\'est visite qu\'une fois.',
            sameAsStart: '"{name}" est deja le point de depart ; il n\'a pas ete ajoute comme etape.',
            sameAsEnd: '"{name}" est deja le point d\'arrivee ; il n\'a pas ete ajoute comme etape.',
            unresolved: '"{name}" n\'a pas pu etre localise sur la carte ; ses distances sont approximatives.',
            haversine: 'Aucune donnee routiere : distances et durees estimees a vol d\'oiseau.',
            mixed: 'Donnees routieres partielles : {filled} distances sur {total} sont estimees a vol d\'oiseau (paires sans itineraire routier), et non des distances de conduite.',
            mixedUnknownCount: 'Donnees routieres partielles : certaines distances sont estimees a vol d\'oiseau, et non des distances de conduite.',
            zeroDistance: 'L\'itineraire entier totalise 0 km : les coordonnees ou la matrice de distances sont inutilisables, les chiffres ci-dessous ne sont donc pas reels.',
            unknownDistance: 'Au moins un troncon n\'a aucune donnee de distance utilisable et compte pour 0 km : les distances, durees et couts ci-dessous sont incomplets.',
            tollsUnknown: 'Les peages n\'ont pas pu etre estimes et ne sont inclus dans aucun total : les chiffres ci-dessous sont un minimum, pas le cout complet.',
            tollsNotAvoided: 'Vous avez demande a eviter les peages, mais l\'itineraire ci-dessous n\'a PAS ete recalcule pour les eviter : les distances et les durees sont celles de l\'itineraire le plus rapide, qui peut emprunter des autoroutes payantes. Les peages sont donc indiques comme non applicables et non comme zero, et le cout affiche est un minimum.',
            tollsClamped: 'L\'IA a estime EUR {value} de peages le jour {day}, un montant invraisemblable pour {km} ; il a ete plafonne a EUR {capped}.',
            roundTrip: 'Voyage circulaire : l\'itineraire revient a {place}.',
            overBudget: 'Budget depasse le(s) jour(s) {days}.'
        },
        map: {
            title: 'Carte de l\'itineraire',
            noRoute: 'Aucun itineraire a tracer pour l\'instant',
            sourceRoad: 'Trace issu du reseau routier reel (OSRM)',
            sourceStraight: 'Lignes droites entre les etapes : une estimation, pas la route',
            straightLineNote: 'Estimation : lignes droites, pas le trace routier reel',
            dayLabel: 'Jour {day} : {from} → {to}',
            legend: 'Jour {day}',
            straightNotice: 'La carte trace des lignes droites entre les etapes car aucune geometrie routiere n\'a pu etre obtenue : le trace est une estimation de la forme du voyage, pas la route que vous conduirez. Les distances et les durees ci-dessus restent inchangees.',
            savedNoGeometry: 'Cet itineraire sauvegarde ne contient aucun trace routier : la carte relie donc les etapes par des lignes droites, une estimation de la forme du voyage et non la route que vous conduirez. Les distances et les durees ci-dessus restent inchangees.'
        },
        exp: {
            title: 'Exporter', gpx: 'GPX', ics: 'Calendrier', print: 'Imprimer / PDF',
            startDate: 'Date de depart du voyage',
            needDate: 'Choisissez la date de depart du voyage pour exporter un calendrier',
            trip: 'Itineraire Travio',
            start: 'Depart', end: 'Arrivee', stop: 'Etape', overnight: 'Nuit',
            restDayAt: 'Journee de repos a {place}',
            cost: 'Cout estime : {amount}',
            costFloor: 'Cout estime : au moins {amount} (incomplet : certains couts sont inconnus)',
            suggestions: 'Suggestions (generees par IA, ne font pas partie de l\'itineraire calcule)',
            viaPoints: 'Points de passage prevus. Les lignes droites entre eux NE sont PAS le trace routier.',
            roadTrack: 'Trace fourni par le service de calcul d\'itineraire routier.',
            unlocated: '{count} lieu(x) n\'ont pas pu etre localises et sont absents de ce fichier.',
            longDay: 'Longue journee de conduite : {drive}, au-dela de la limite de {cap} donnee au planificateur.',
            longDayNoCap: 'Longue journee de conduite : au-dela de la limite quotidienne donnee au planificateur.',
            plannerNotes: 'Notes du planificateur',
            unreliable: 'Les distances et les durees de ce voyage n\'ont pas pu etre calculees et sont omises.',
            notAvailable: 'non disponible',
            atLeast: 'au moins {value}'
        },
        routes: {
            title: 'Mes Itineraires Sauvegardes', noRoutes: 'Vous n\'avez aucun itineraire sauvegarde',
            load: 'Voir', delete: 'Supprimer', confirmDelete: 'Supprimer cet itineraire?',
            back: 'Retour'
        },
        admin: {
            title: 'Panneau d\'Administration', users: 'Utilisateurs',
            createUser: 'Creer Utilisateur', editUser: 'Modifier Utilisateur',
            name: 'Nom', email: 'Email', password: 'Mot de passe', role: 'Role',
            roleAdmin: 'Administrateur', roleUser: 'Utilisateur', language: 'Langue',
            save: 'Sauvegarder', cancel: 'Annuler', delete: 'Supprimer',
            confirmDelete: 'Supprimer cet utilisateur?', resetPwd: 'Reinitialiser le mot de passe',
            back: 'Retour', created: 'Utilisateur cree', updated: 'Utilisateur mis a jour', deleted: 'Utilisateur supprime'
        },
        footer: { credit: 'Cree avec amour par Travio', tagline: 'Votre compagnon de voyage intelligent' },
        common: { save: 'Sauvegarder', cancel: 'Annuler', delete: 'Supprimer', confirm: 'Confirmer', error: 'Erreur', success: 'Succes', loading: 'Chargement...' }
    },
    zh: {
        app:  { name: 'Travio', tagline: '您的旅行伙伴', subtitle: '规划、优化并享受每一公里' },
        login: { title: '登录', email: '电子邮件', password: '密码', signIn: '登录', signingIn: '登录中...', errorRequired: '请输入邮箱和密码', errorInvalid: '邮箱或密码无效', errorNoAccount: '账户未配置' },
        nav:  { logout: '退出', admin: '管理', savedRoutes: '我的路线', newRoute: '新路线', welcome: '你好' },
        form: {
            title: '旅行数据',
            startPoint: '出发点', startPointPh: '例如：北京',
            endPoint: '终点', endPointPh: '例如：北京（环形旅行）',
            destinations: '要访问的目的地', destinationsHint: '（用逗号分隔）', destinationsPh: '例如：上海、杭州、苏州',
            tripType: '旅行类型',
            family: '家庭', couple: '情侣', adventure: '冒险', motorcycle: '摩托车',
            duration: '持续时间（天）', dailyBudget: '每日预算（EUR）',
            advancedOptions: '高级选项', customizeBudget: '自定义每日预算', day: '第',
            tollPreference: '收费偏好', withTolls: '使用收费公路（更快）', withoutTolls: '避免收费（经济/风景）',
            departureTime: '出发时间',
            costAssumptions: '费用假设',
            consumption: '油耗（升/100公里）', fuelPrice: '燃油价格（EUR/升）',
            lodgingPerNight: '每晚住宿（EUR）', mealsPerDay: '每日餐费（EUR）',
            generate: '使用AI生成路线', generating: '正在创建您的完美路线...', clear: '清除',
            required: '请填写所有必填字段'
        },
        tripTypeLabel: { familiar: '家庭', pareja: '情侣', aventura: '冒险', moto: '摩托车' },
        result: {
            title: '结果', saveRoute: '保存路线', routeSaved: '路线已保存',
            emptyState: '填写表格并生成路线以在此处查看结果',
            analyzing: '正在分析您旅行的最佳路线...', waitTime: '这可能需要15-30秒',
            route: '路线', days: '天', budget: '预算', error: '生成路线时出错'
        },
        unit: { hour: '小时', minute: '分钟', km: '公里' },
        progress: {
            geocoding: '正在地图上定位地点',
            geocodingItem: '{done}/{total} - {name}',
            matrix: '正在测量真实道路距离',
            geocodedAs: '{name}：定位到 {label}',
            planning: '正在优化路线并分配每日行程',
            mapping: '正在地图上绘制路线',
            enriching: '正在添加当地推荐',
            done: '行程已就绪',
            ratePolicy: '地图服务每秒仅允许一次查询，因此需要等待几秒钟。'
        },
        itin: {
            summary: '行程摘要',
            totalKm: '总距离', totalTime: '总驾驶时间',
            totalCost: '预计费用', totalBudget: '总预算',
            overBudgetBy: '超出预算 {amount}', underBudgetBy: '预算剩余 {amount}',
            sourceRoad: '距离与时间来自真实道路网络（OSRM）',
            sourceEstimated: '距离根据坐标估算（无道路数据）',
            sourcePartial: '道路数据不完整：部分路段为直线估算',
            dayN: '第 {day} 天', distance: '距离', driveTime: '驾驶时间',
            departureArrival: '出发 / 到达', arriveAt: '到达 {time}',
            overnight: '在 {place} 过夜', stops: '停靠点',
            restDay: '休息日', restDayAt: '在 {place} 休息或游览：当天无需驾驶。',
            longDay: '长途驾驶',
            fuel: '燃油', tolls: '过路费', lodging: '住宿', meals: '餐饮',
            total: '当日总计', budget: '当日预算',
            withinBudget: '在预算之内', estimate: '（估算）',
            unknownValue: '—', tollsNotEstimated: '（未估算）', tollsNotApplicable: '（不适用）',
            tollsCapped: '（估算已封顶）', tollsNoDriving: '（当日无驾驶）',
            atLeast: '至少 {amount}',
            overBudgetByWithEstimate: '超出预算 {amount}，该数字包含 AI 估算的过路费 {tolls}',
            withinBudgetIncomplete: '已计入的项目在预算之内；合计并不完整',
            budgetNotAssessable: '无法评估预算：上方的距离数据不可用',
            overBudgetByEstimated: '超出预算 {amount}，但仅因 AI 估算的过路费（{tolls}）所致',
            activities: '活动', mealsIdeas: '用餐推荐',
            meal_breakfast: '早餐', meal_lunch: '午餐', meal_dinner: '晚餐',
            meal_other: '用餐推荐',
            lodgingIdea: '住宿推荐', tip: '当地贴士',
            enrichUnavailable: '当地推荐暂时不可用。下方的路线、天数、距离和时间均已计算完成，且不依赖这些推荐。费用仅包含每日表格中列出的项目。',
            enrichPartial: '第 {days} 天没有推荐内容。已计算的行程不受影响。',
            ratesNote: '燃油 {consumption} 升/100公里，EUR {price}/升 - 住宿 EUR {lodging}/晚 - 餐饮 EUR {meals}/天',
            geoTitle: '每个地点的实际定位',
            geoNote: '这些名称来自 OpenStreetMap 地理编码服务，不是 Travio 生成的。如果其中某一项不是你想去的地方，请把名称写得更精确（加上地区、省份或国家）后重新生成路线。',
            geoNotLocated: '无法定位',
            geoNoLabel: '地理编码服务未返回名称',
            geoBadgeOutlier: '距行程其余部分 {km}',
            geoBadgeOutlierFar: '远离行程其余部分',
            geoBadgeMatches: '有 {count} 个地点与这个名称匹配',
            geoBadgeMoved: '并非第一个匹配结果：因更靠近行程其余部分而被选中'
        },
        notice: {
            geoOutlier: '"{name}" 被定位到 {label}，距离行程其余部分 {km}。如果这不是你想去的地方，下方的距离、时间和费用都属于一趟你没有要求的行程。',
            geoOutlierNoDistance: '"{name}" 被定位到 {label}，远离行程其余部分。如果这不是你想去的地方，下方的距离、时间和费用都属于一趟你没有要求的行程。',
            geoRelocated: '"{name}" 匹配到多个地点。这里使用的是 {label}，选它是因为它更靠近行程其余部分，而不是因为它是地理编码服务的第一个结果。如果你指的是别处，请把名称写得更精确。',
            geoAmbiguous: '你输入的名称中有 {count} 个匹配到多个地点（{names}）。上方的列表逐一显示了实际使用的是哪一个。',
            restDay: '第 {day} 天：无驾驶，在 {place} 休息或游览。',
            overCap: '第 {day} 天驾驶 {drive}，超过每日 {cap} 的上限。',
            duplicate: '"{name}" 重复出现；只安排访问一次。',
            sameAsStart: '"{name}" 已是出发点；未作为停靠点添加。',
            sameAsEnd: '"{name}" 已是终点；未作为停靠点添加。',
            unresolved: '无法在地图上定位 "{name}"；其距离为近似值。',
            haversine: '无道路数据：距离和时间为直线估算值。',
            mixed: '道路数据不完整：{total} 段距离中有 {filled} 段为直线估算（无可行驶路线的路段），并非实际驾驶距离。',
            mixedUnknownCount: '道路数据不完整：部分距离为直线估算，并非实际驾驶距离。',
            zeroDistance: '整个行程合计为 0 公里：坐标或距离矩阵不可用，因此下方的数字并不真实。',
            unknownDistance: '至少有一段没有可用的距离数据，按 0 公里计算：下方的距离、时间和费用并不完整。',
            tollsUnknown: '无法估算过路费，因此未计入任何合计：下方的数字为最低值，并非完整费用。',
            tollsNotAvoided: '您选择了避开收费公路，但下方路线并未重新规划以避开收费：距离和时间均为最快路线的数据，该路线可能使用收费公路。因此过路费显示为不适用而非零，所示费用为最低值。',
            tollsClamped: 'AI 估算第 {day} 天的过路费为 EUR {value}，对 {km} 而言不合理；已上限至 EUR {capped}。',
            roundTrip: '环形旅行：行程将返回 {place}。',
            overBudget: '第 {days} 天超出预算。'
        },
        map: {
            title: '路线地图',
            noRoute: '暂时没有可绘制的路线',
            sourceRoad: '线条来自真实道路网络（OSRM）',
            sourceStraight: '停靠点之间为直线：这是估算，并非实际道路',
            straightLineNote: '估算：直线连接，并非实际道路走向',
            dayLabel: '第 {day} 天：{from} → {to}',
            legend: '第 {day} 天',
            straightNotice: '由于未能获取道路几何数据，地图以直线连接各停靠点：该线条只是行程形状的估算，并非您实际行驶的路线。上方的距离与时间不受影响。',
            savedNoGeometry: '这条已保存的路线没有存储道路轨迹，因此地图以直线连接各停靠点：这只是行程形状的估算，并非您实际行驶的路线。上方的距离与时间不受影响。'
        },
        exp: {
            title: '导出', gpx: 'GPX', ics: '日历', print: '打印 / PDF',
            startDate: '出发日期',
            needDate: '请选择出发日期后再导出日历',
            trip: 'Travio 路线',
            start: '起点', end: '终点', stop: '停靠点', overnight: '过夜',
            restDayAt: '在 {place} 休息一天',
            cost: '预计费用：{amount}',
            costFloor: '预计费用：至少 {amount}（不完整：部分费用未知）',
            suggestions: '建议（由 AI 生成，不属于已计算的路线）',
            viaPoints: '计划途经点。它们之间的直线并非实际道路走向。',
            roadTrack: '轨迹来自道路路径规划服务。',
            unlocated: '有 {count} 个地点无法定位，未包含在此文件中。',
            longDay: '长途驾驶日：{drive}，超过规划器所设定的 {cap} 上限。',
            longDayNoCap: '长途驾驶日：超过规划器所设定的每日上限。',
            plannerNotes: '规划器提示',
            unreliable: '本次行程的距离与时间无法计算，已省略。',
            notAvailable: '不可用',
            atLeast: '至少 {value}'
        },
        routes: {
            title: '我的已保存路线', noRoutes: '您没有已保存的路线',
            load: '查看', delete: '删除', confirmDelete: '删除此路线？',
            back: '返回'
        },
        admin: {
            title: '管理面板', users: '用户',
            createUser: '创建用户', editUser: '编辑用户',
            name: '姓名', email: '邮箱', password: '密码', role: '角色',
            roleAdmin: '管理员', roleUser: '用户', language: '语言',
            save: '保存', cancel: '取消', delete: '删除',
            confirmDelete: '删除此用户？', resetPwd: '重置密码',
            back: '返回', created: '用户已创建', updated: '用户已更新', deleted: '用户已删除'
        },
        footer: { credit: '由Travio用心制作', tagline: '您的智能旅行伙伴' },
        common: { save: '保存', cancel: '取消', delete: '删除', confirm: '确认', error: '错误', success: '成功', loading: '加载中...' }
    }
};

let currentLang = localStorage.getItem('travio-lang') || 'es';

/** Dot-notation key lookup: t('form.startPoint') */
function t(key) {
    const parts = key.split('.');
    let val = TRANSLATIONS[currentLang];
    for (const p of parts) {
        if (!val || val[p] === undefined) {
            // Fallback to English
            val = TRANSLATIONS.en;
            for (const fp of parts) { if (val) val = val[fp]; }
            return val || key;
        }
        val = val[p];
    }
    return val || key;
}

/** Parameterised lookup: tf('itin.dayN', { day: 2 }) -> 'Day 2' */
function tf(key, params) {
    const str = t(key);
    if (typeof str !== 'string' || !params) return str;
    return str.replace(/\{(\w+)\}/g, (m, k) =>
        Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m);
}

/** Switch language, persist, and re-render */
function setLanguage(lang) {
    if (!TRANSLATIONS[lang]) return;
    currentLang = lang;
    localStorage.setItem('travio-lang', lang);
    applyTranslations();
    /* applyTranslations() only touches [data-i18n]; the itinerary is built in JS and
       would otherwise stay frozen in the previous language — every label, notice and
       budget verdict included. Anything rendered outside the markup registers a
       re-render hook here so a language switch really switches the whole screen. */
    for (let i = 0; i < LANGUAGE_LISTENERS.length; i++) {
        try { LANGUAGE_LISTENERS[i](lang); } catch (e) { console.warn('i18n listener failed:', e); }
    }
    // Update language selector if present
    const sel = document.getElementById('langSelect');
    if (sel) sel.value = lang;
    const selLogin = document.getElementById('langSelectLogin');
    if (selLogin) selLogin.value = lang;
}

/** Re-render hooks for JS-built surfaces (see setLanguage). */
const LANGUAGE_LISTENERS = [];
function onLanguageChange(fn) {
    if (typeof fn === 'function' && LANGUAGE_LISTENERS.indexOf(fn) === -1) LANGUAGE_LISTENERS.push(fn);
}

/** Re-render all [data-i18n] elements in visible DOM */
function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const translated = t(key);
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            el.placeholder = translated;
        } else if (el.tagName === 'OPTION') {
            el.textContent = translated;
        } else {
            el.textContent = translated;
        }
    });
}
