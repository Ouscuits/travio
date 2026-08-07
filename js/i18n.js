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
            matrix: 'Midiendo distancias reales por carretera',
            planning: 'Optimizando la ruta y repartiendo los dias',
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
            unknownValue: '—', tollsNotEstimated: '(sin estimar)',
            atLeast: 'al menos {amount}',
            withinBudgetIncomplete: 'Dentro del presupuesto en lo contabilizado; faltan los peajes',
            budgetNotAssessable: 'No se puede valorar el presupuesto: las distancias de arriba no son utilizables',
            overBudgetByEstimated: 'Excede el presupuesto en {amount}, pero solo por el peaje estimado por la IA ({tolls})',
            activities: 'Actividades', mealsIdeas: 'Donde comer',
            meal_breakfast: 'Desayuno', meal_lunch: 'Comida', meal_dinner: 'Cena',
            meal_other: 'Para comer',
            lodgingIdea: 'Donde dormir', tip: 'Consejo local',
            enrichUnavailable: 'Las recomendaciones locales no estan disponibles ahora. La ruta, los dias, las distancias y los tiempos de abajo estan calculados y no dependen de ellas. Los costes solo incluyen los conceptos que aparecen en la tabla de cada dia.',
            enrichPartial: 'Sin recomendaciones para el/los dia(s) {days}. El itinerario calculado no se ve afectado.',
            ratesNote: 'Combustible {consumption} L/100 km a EUR {price}/L - alojamiento EUR {lodging}/noche - comidas EUR {meals}/dia'
        },
        notice: {
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
            tollsClamped: 'La IA estimo EUR {value} de peajes el dia {day}, una cifra inverosimil para {km}; se ha limitado a EUR {capped}.',
            roundTrip: 'Viaje circular: el itinerario vuelve a {place}.',
            overBudget: 'Presupuesto excedido el/los dia(s) {days}.'
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
            matrix: 'Measuring real road distances',
            planning: 'Optimising the route and splitting the days',
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
            unknownValue: '—', tollsNotEstimated: '(not estimated)',
            atLeast: 'at least {amount}',
            withinBudgetIncomplete: 'Within budget for what is counted; tolls are missing',
            budgetNotAssessable: 'The budget cannot be assessed: the distances above are not usable',
            overBudgetByEstimated: 'Over budget by {amount}, but only because of the AI-estimated toll ({tolls})',
            activities: 'Activities', mealsIdeas: 'Where to eat',
            meal_breakfast: 'Breakfast', meal_lunch: 'Lunch', meal_dinner: 'Dinner',
            meal_other: 'Where to eat',
            lodgingIdea: 'Where to sleep', tip: 'Local tip',
            enrichUnavailable: 'Local recommendations are not available right now. The route, days, distances and times below are computed and do not depend on them. Costs cover only the items listed in each day\'s table.',
            enrichPartial: 'No recommendations for day(s) {days}. The computed itinerary is unaffected.',
            ratesNote: 'Fuel {consumption} L/100 km at EUR {price}/L - lodging EUR {lodging}/night - meals EUR {meals}/day'
        },
        notice: {
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
            tollsClamped: 'The AI estimated EUR {value} of tolls on day {day}, which is not plausible for {km}; it has been capped at EUR {capped}.',
            roundTrip: 'Round trip: the itinerary returns to {place}.',
            overBudget: 'Over budget on day(s) {days}.'
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
            matrix: 'Mesurant distancies reals per carretera',
            planning: 'Optimitzant la ruta i repartint els dies',
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
            unknownValue: '—', tollsNotEstimated: '(sense estimar)',
            atLeast: 'com a minim {amount}',
            withinBudgetIncomplete: 'Dins del pressupost pel que s\'ha comptat; falten els peatges',
            budgetNotAssessable: 'No es pot valorar el pressupost: les distancies de sobre no son utilitzables',
            overBudgetByEstimated: 'Supera el pressupost en {amount}, pero nomes pel peatge estimat per la IA ({tolls})',
            activities: 'Activitats', mealsIdeas: 'On menjar',
            meal_breakfast: 'Esmorzar', meal_lunch: 'Dinar', meal_dinner: 'Sopar',
            meal_other: 'Per menjar',
            lodgingIdea: 'On dormir', tip: 'Consell local',
            enrichUnavailable: 'Les recomanacions locals no estan disponibles ara. La ruta, els dies, les distancies i els temps de sota estan calculats i no en depenen. Els costos nomes inclouen els conceptes que apareixen a la taula de cada dia.',
            enrichPartial: 'Sense recomanacions per al(s) dia(es) {days}. L\'itinerari calculat no queda afectat.',
            ratesNote: 'Combustible {consumption} L/100 km a EUR {price}/L - allotjament EUR {lodging}/nit - apats EUR {meals}/dia'
        },
        notice: {
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
            tollsClamped: 'La IA va estimar EUR {value} de peatges el dia {day}, una xifra inversemblant per a {km}; s\'ha limitat a EUR {capped}.',
            roundTrip: 'Viatge circular: l\'itinerari torna a {place}.',
            overBudget: 'Pressupost superat el(s) dia(es) {days}.'
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
            matrix: 'Mesure des distances routieres reelles',
            planning: 'Optimisation de l\'itineraire et repartition des jours',
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
            unknownValue: '—', tollsNotEstimated: '(non estime)',
            atLeast: 'au moins {amount}',
            withinBudgetIncomplete: 'Dans le budget pour ce qui est comptabilise ; les peages manquent',
            budgetNotAssessable: 'Le budget ne peut pas etre evalue : les distances ci-dessus sont inutilisables',
            overBudgetByEstimated: 'Depasse le budget de {amount}, mais uniquement a cause du peage estime par l\'IA ({tolls})',
            activities: 'Activites', mealsIdeas: 'Ou manger',
            meal_breakfast: 'Petit-dejeuner', meal_lunch: 'Dejeuner', meal_dinner: 'Diner',
            meal_other: 'Ou manger',
            lodgingIdea: 'Ou dormir', tip: 'Conseil local',
            enrichUnavailable: 'Les recommandations locales ne sont pas disponibles pour le moment. L\'itineraire, les jours, les distances et les durees ci-dessous sont calcules et n\'en dependent pas. Les couts ne couvrent que les postes listes dans le tableau de chaque jour.',
            enrichPartial: 'Aucune recommandation pour le(s) jour(s) {days}. L\'itineraire calcule reste inchange.',
            ratesNote: 'Carburant {consumption} L/100 km a EUR {price}/L - hebergement EUR {lodging}/nuit - repas EUR {meals}/jour'
        },
        notice: {
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
            tollsClamped: 'L\'IA a estime EUR {value} de peages le jour {day}, un montant invraisemblable pour {km} ; il a ete plafonne a EUR {capped}.',
            roundTrip: 'Voyage circulaire : l\'itineraire revient a {place}.',
            overBudget: 'Budget depasse le(s) jour(s) {days}.'
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
            planning: '正在优化路线并分配每日行程',
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
            unknownValue: '—', tollsNotEstimated: '（未估算）',
            atLeast: '至少 {amount}',
            withinBudgetIncomplete: '已计入的项目在预算之内；过路费缺失',
            budgetNotAssessable: '无法评估预算：上方的距离数据不可用',
            overBudgetByEstimated: '超出预算 {amount}，但仅因 AI 估算的过路费（{tolls}）所致',
            activities: '活动', mealsIdeas: '用餐推荐',
            meal_breakfast: '早餐', meal_lunch: '午餐', meal_dinner: '晚餐',
            meal_other: '用餐推荐',
            lodgingIdea: '住宿推荐', tip: '当地贴士',
            enrichUnavailable: '当地推荐暂时不可用。下方的路线、天数、距离和时间均已计算完成，且不依赖这些推荐。费用仅包含每日表格中列出的项目。',
            enrichPartial: '第 {days} 天没有推荐内容。已计算的行程不受影响。',
            ratesNote: '燃油 {consumption} 升/100公里，EUR {price}/升 - 住宿 EUR {lodging}/晚 - 餐饮 EUR {meals}/天'
        },
        notice: {
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
            tollsClamped: 'AI 估算第 {day} 天的过路费为 EUR {value}，对 {km} 而言不合理；已上限至 EUR {capped}。',
            roundTrip: '环形旅行：行程将返回 {place}。',
            overBudget: '第 {days} 天超出预算。'
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
