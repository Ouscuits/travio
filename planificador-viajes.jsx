import React, { useState } from 'react';
import { MapPin, Calendar, DollarSign, Clock, Route, Save, Trash2, ChevronDown, ChevronUp } from 'lucide-react';

export default function PlanificadorViajes() {
  // Estado para el formulario
  const [formData, setFormData] = useState({
    puntoPartida: '',
    puntoFinal: '',
    destinos: '',
    tipoViaje: 'familiar',
    duracionDias: 3,
    presupuestoDiario: 100,
    presupuestoPersonalizado: false,
    presupuestosPorDia: {},
    preferenciaPeajes: 'con-peajes',
    horaSalida: '09:00'
  });

  // Estado para mostrar/ocultar opciones avanzadas
  const [mostrarAvanzado, setMostrarAvanzado] = useState(false);
  
  // Estado para la ruta generada
  const [rutaGenerada, setRutaGenerada] = useState(null);
  
  // Estado para rutas guardadas
  const [rutasGuardadas, setRutasGuardadas] = useState([]);
  
  // Estado de carga
  const [cargando, setCargando] = useState(false);

  // Manejar cambios en el formulario
  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));
  };

  // Manejar presupuesto personalizado por día
  const handlePresupuestoDia = (dia, valor) => {
    setFormData(prev => ({
      ...prev,
      presupuestosPorDia: {
        ...prev.presupuestosPorDia,
        [dia]: parseFloat(valor) || 0
      }
    }));
  };

  // Validar formulario
  const formularioValido = () => {
    return formData.puntoPartida && 
           formData.puntoFinal && 
           formData.destinos && 
           formData.duracionDias > 0 && 
           formData.presupuestoDiario > 0;
  };

  // Generar la ruta (aquí llamaremos a Claude API)
  const generarRuta = async () => {
    if (!formularioValido()) return;
    
    setCargando(true);
    
    try {
      // Preparar el prompt para Claude
      const destinosArray = formData.destinos.split(',').map(d => d.trim());
      
      const prompt = `Eres un experto planificador de viajes. Necesito que me ayudes a planificar una ruta optimizada con los siguientes detalles:

**INFORMACIÓN DEL VIAJE:**
- Punto de partida: ${formData.puntoPartida}
- Punto final: ${formData.puntoFinal}
- Destinos a visitar: ${destinosArray.join(', ')}
- Tipo de viaje: ${formData.tipoViaje}
- Duración: ${formData.duracionDias} días
- Presupuesto diario: €${formData.presupuestoDiario}
- Preferencia de peajes: ${formData.preferenciaPeajes === 'con-peajes' ? 'Usar autopistas de peaje (más rápido)' : 'Evitar peajes (más económico/escénico)'}
- Hora de salida: ${formData.horaSalida}

**LO QUE NECESITO:**

1. **RUTA OPTIMIZADA**: Ordena los destinos de forma lógica para minimizar distancia y tiempo. Considera la preferencia de peajes.

2. **ITINERARIO DETALLADO POR DÍA**: Para cada día del viaje, proporciona:
   - Destinos a visitar ese día
   - Distancia aproximada en km
   - Tiempo estimado de conducción
   - Hora estimada de llegada a cada punto
   - Si hay peajes, menciónalo y estima el coste aproximado

3. **DESGLOSE DE COSTES**: Para cada día, estima:
   - Gasolina (asume consumo medio de 7L/100km y €1.50/litro)
   - Peajes (si aplica)
   - Alojamiento sugerido dentro del presupuesto
   - Comidas (desayuno, comida, cena)
   - Total del día vs presupuesto disponible
   - ALERTA si se excede el presupuesto

4. **SUGERENCIAS PERSONALIZADAS** según el tipo de viaje:
${formData.tipoViaje === 'familiar' ? '   - Restaurantes family-friendly\n   - Parques y atracciones para niños\n   - Hoteles con facilidades familiares' : ''}
${formData.tipoViaje === 'pareja' ? '   - Restaurantes románticos\n   - Miradores y lugares especiales\n   - Hoteles boutique o con encanto' : ''}
${formData.tipoViaje === 'aventura' ? '   - Rutas de senderismo\n   - Actividades al aire libre\n   - Camping o albergues económicos' : ''}
${formData.tipoViaje === 'moto' ? '   - Carreteras panorámicas y puertos de montaña\n   - Paradas técnicas para motos\n   - Hostales moteros\n   - Rutas con curvas interesantes' : ''}

5. **PARADAS INTERMEDIAS**: Sugiere pueblos bonitos o áreas de descanso en el camino.

6. **RESUMEN FINAL**: 
   - Kilómetros totales
   - Tiempo total de conducción
   - Coste total estimado del viaje
   - Comparación con presupuesto total disponible

Por favor, estructura la respuesta de forma clara y profesional. Usa búsqueda web si necesitas información actualizada sobre distancias, peajes o puntos de interés específicos.`;

      // Llamar a Claude API
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4000,
          messages: [
            { role: "user", content: prompt }
          ],
          tools: [
            {
              "type": "web_search_20250305",
              "name": "web_search"
            }
          ]
        })
      });

      const data = await response.json();
      
      // Procesar la respuesta
      let respuestaCompleta = '';
      for (const block of data.content) {
        if (block.type === 'text') {
          respuestaCompleta += block.text + '\n';
        }
      }

      // Guardar la ruta generada
      const nuevaRuta = {
        id: Date.now(),
        fecha: new Date().toLocaleString('es-ES'),
        datos: formData,
        resultado: respuestaCompleta
      };
      
      setRutaGenerada(nuevaRuta);
      
    } catch (error) {
      console.error('Error al generar ruta:', error);
      alert('Hubo un error al generar la ruta. Por favor, intenta de nuevo.');
    } finally {
      setCargando(false);
    }
  };

  // Guardar ruta en el historial
  const guardarRuta = () => {
    if (rutaGenerada) {
      setRutasGuardadas(prev => [rutaGenerada, ...prev]);
      alert('¡Ruta guardada correctamente!');
    }
  };

  // Cargar una ruta guardada
  const cargarRuta = (ruta) => {
    setFormData(ruta.datos);
    setRutaGenerada(ruta);
  };

  // Eliminar una ruta guardada
  const eliminarRuta = (id) => {
    setRutasGuardadas(prev => prev.filter(r => r.id !== id));
  };

  // Limpiar formulario
  const limpiarFormulario = () => {
    setFormData({
      puntoPartida: '',
      puntoFinal: '',
      destinos: '',
      tipoViaje: 'familiar',
      duracionDias: 3,
      presupuestoDiario: 100,
      presupuestoPersonalizado: false,
      presupuestosPorDia: {},
      preferenciaPeajes: 'con-peajes',
      horaSalida: '09:00'
    });
    setRutaGenerada(null);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-6">
      <div className="max-w-6xl mx-auto">
        
        {/* Encabezado */}
        <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
          <h1 className="text-3xl font-bold text-gray-800 mb-2 flex items-center gap-2">
            <Route className="text-indigo-600" size={32} />
            Planificador Inteligente de Viajes
          </h1>
          <p className="text-gray-600">Crea tu ruta perfecta optimizada con IA</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* Panel izquierdo - Formulario */}
          <div className="lg:col-span-1">
            <div className="bg-white rounded-lg shadow-lg p-6">
              <h2 className="text-xl font-semibold text-gray-800 mb-4">Datos del Viaje</h2>
              
              {/* Punto de partida */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  <MapPin size={16} className="inline mr-1" />
                  Punto de partida *
                </label>
                <input
                  type="text"
                  name="puntoPartida"
                  value={formData.puntoPartida}
                  onChange={handleChange}
                  placeholder="ej: Madrid"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                />
              </div>

              {/* Punto final */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  <MapPin size={16} className="inline mr-1" />
                  Punto final *
                </label>
                <input
                  type="text"
                  name="puntoFinal"
                  value={formData.puntoFinal}
                  onChange={handleChange}
                  placeholder="ej: Madrid (viaje circular)"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                />
              </div>

              {/* Destinos */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Destinos a visitar * <span className="text-xs text-gray-500">(separados por comas)</span>
                </label>
                <textarea
                  name="destinos"
                  value={formData.destinos}
                  onChange={handleChange}
                  placeholder="ej: Santiago de Compostela, Finisterre, A Coruña, Lugo"
                  rows="3"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                />
              </div>

              {/* Tipo de viaje */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Tipo de viaje *
                </label>
                <select
                  name="tipoViaje"
                  value={formData.tipoViaje}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                >
                  <option value="familiar">👨‍👩‍👧‍👦 Familiar</option>
                  <option value="pareja">💑 En pareja</option>
                  <option value="aventura">🏔️ Aventura</option>
                  <option value="moto">🏍️ En moto</option>
                </select>
              </div>

              {/* Duración */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  <Calendar size={16} className="inline mr-1" />
                  Duración (días) *
                </label>
                <input
                  type="number"
                  name="duracionDias"
                  value={formData.duracionDias}
                  onChange={handleChange}
                  min="1"
                  max="30"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                />
              </div>

              {/* Presupuesto diario */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  <DollarSign size={16} className="inline mr-1" />
                  Presupuesto diario (€) *
                </label>
                <input
                  type="number"
                  name="presupuestoDiario"
                  value={formData.presupuestoDiario}
                  onChange={handleChange}
                  min="10"
                  step="10"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                />
              </div>

              {/* Opciones avanzadas */}
              <div className="mb-4">
                <button
                  type="button"
                  onClick={() => setMostrarAvanzado(!mostrarAvanzado)}
                  className="w-full flex items-center justify-between text-sm font-medium text-indigo-600 hover:text-indigo-800 py-2"
                >
                  <span>Opciones avanzadas</span>
                  {mostrarAvanzado ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
                
                {mostrarAvanzado && (
                  <div className="mt-4 space-y-4 border-t pt-4">
                    {/* Presupuesto personalizado */}
                    <div>
                      <label className="flex items-center text-sm font-medium text-gray-700 mb-2">
                        <input
                          type="checkbox"
                          name="presupuestoPersonalizado"
                          checked={formData.presupuestoPersonalizado}
                          onChange={handleChange}
                          className="mr-2"
                        />
                        Personalizar presupuesto por día
                      </label>
                      
                      {formData.presupuestoPersonalizado && (
                        <div className="ml-6 space-y-2">
                          {[...Array(parseInt(formData.duracionDias))].map((_, i) => (
                            <div key={i} className="flex items-center gap-2">
                              <span className="text-sm text-gray-600 w-16">Día {i + 1}:</span>
                              <input
                                type="number"
                                value={formData.presupuestosPorDia[i + 1] || formData.presupuestoDiario}
                                onChange={(e) => handlePresupuestoDia(i + 1, e.target.value)}
                                min="10"
                                step="10"
                                className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                              />
                              <span className="text-sm text-gray-600">€</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Preferencia de peajes */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Preferencia de peajes
                      </label>
                      <select
                        name="preferenciaPeajes"
                        value={formData.preferenciaPeajes}
                        onChange={handleChange}
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                      >
                        <option value="con-peajes">⚡ Con peajes (más rápido)</option>
                        <option value="sin-peajes">🌄 Sin peajes (económico/escénico)</option>
                      </select>
                    </div>

                    {/* Hora de salida */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        <Clock size={16} className="inline mr-1" />
                        Hora de salida
                      </label>
                      <input
                        type="time"
                        name="horaSalida"
                        value={formData.horaSalida}
                        onChange={handleChange}
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Botones de acción */}
              <div className="space-y-2">
                <button
                  onClick={generarRuta}
                  disabled={!formularioValido() || cargando}
                  className="w-full bg-indigo-600 text-white py-3 rounded-md font-semibold hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
                >
                  {cargando ? 'Generando ruta...' : '🚀 Generar Ruta'}
                </button>
                
                <button
                  onClick={limpiarFormulario}
                  className="w-full bg-gray-200 text-gray-700 py-2 rounded-md font-medium hover:bg-gray-300 transition-colors"
                >
                  Limpiar
                </button>
              </div>
            </div>

            {/* Rutas guardadas */}
            {rutasGuardadas.length > 0 && (
              <div className="bg-white rounded-lg shadow-lg p-6 mt-6">
                <h3 className="text-lg font-semibold text-gray-800 mb-4">Rutas Guardadas</h3>
                <div className="space-y-2">
                  {rutasGuardadas.map(ruta => (
                    <div key={ruta.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-md">
                      <div className="flex-1">
                        <p className="text-sm font-medium text-gray-800">
                          {ruta.datos.puntoPartida} → {ruta.datos.puntoFinal}
                        </p>
                        <p className="text-xs text-gray-500">{ruta.fecha}</p>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => cargarRuta(ruta)}
                          className="text-indigo-600 hover:text-indigo-800"
                          title="Cargar ruta"
                        >
                          <Route size={16} />
                        </button>
                        <button
                          onClick={() => eliminarRuta(ruta.id)}
                          className="text-red-600 hover:text-red-800"
                          title="Eliminar ruta"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Panel derecho - Resultados */}
          <div className="lg:col-span-2">
            <div className="bg-white rounded-lg shadow-lg p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold text-gray-800">Resultado</h2>
                {rutaGenerada && (
                  <button
                    onClick={guardarRuta}
                    className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors"
                  >
                    <Save size={16} />
                    Guardar Ruta
                  </button>
                )}
              </div>

              {!rutaGenerada && !cargando && (
                <div className="text-center py-12">
                  <Route size={64} className="mx-auto text-gray-300 mb-4" />
                  <p className="text-gray-500">Completa el formulario y genera tu ruta para ver los resultados aquí</p>
                </div>
              )}

              {cargando && (
                <div className="text-center py-12">
                  <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-indigo-600 mx-auto mb-4"></div>
                  <p className="text-gray-600 font-medium">Analizando la mejor ruta para tu viaje...</p>
                  <p className="text-gray-500 text-sm mt-2">Esto puede tardar 15-30 segundos</p>
                </div>
              )}

              {rutaGenerada && !cargando && (
                <div className="prose max-w-none">
                  <div className="bg-indigo-50 border-l-4 border-indigo-600 p-4 mb-6">
                    <h3 className="text-lg font-semibold text-indigo-900 mb-2">
                      Ruta: {rutaGenerada.datos.puntoPartida} → {rutaGenerada.datos.puntoFinal}
                    </h3>
                    <p className="text-sm text-indigo-700">
                      {rutaGenerada.datos.duracionDias} días • {rutaGenerada.datos.tipoViaje} • 
                      Presupuesto: €{rutaGenerada.datos.presupuestoDiario}/día
                    </p>
                  </div>
                  
                  <div className="whitespace-pre-wrap text-gray-800 leading-relaxed">
                    {rutaGenerada.resultado}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
