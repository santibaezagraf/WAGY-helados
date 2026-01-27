import { DialogTitle } from "@radix-ui/react-dialog";
import { Dialog, DialogContent, DialogHeader } from "../ui/dialog";
import React from "react";
import { actualizarCostoEnvioPedido } from "@/lib/actions/pedidos";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useRouter } from "next/navigation";


interface EditCostoEnvioModalProps {
    id: number;
    costoEnvio: number;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function EditCostoEnvioModal({ id, costoEnvio, open, onOpenChange }: EditCostoEnvioModalProps) {
    const [newCostoEnvioStr, setNewCostoEnvioStr] = React.useState(costoEnvio.toString());
    const newCostoEnvio = parseInt(newCostoEnvioStr) || 0;

    const router = useRouter();

    // Sincronizar el estado cuando se abre el modal
    React.useEffect(() => {
        if (open) {
            setNewCostoEnvioStr(costoEnvio.toString());
        }
    }, [open, costoEnvio]);

    const handleSave = React.useCallback(async () => {
        try {
            await actualizarCostoEnvioPedido(id, newCostoEnvio);
            onOpenChange(false);
            router.refresh();
        } catch (error) {
            console.error("Error al actualizar costo de envío:", error);
        } 
    }, [id, newCostoEnvio, onOpenChange, router]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="w-[95vw] max-w-[500px] bg-gradient-to-br from-white to-cyan-50">
                <DialogHeader className="pb-4">
                    <DialogTitle className="text-2xl sm:text-3xl font-bold text-center text-slate-800">
                        Editar Costo de Envío
                    </DialogTitle>
                </DialogHeader>

                <div className="space-y-4 py-4">
                    <div className="bg-white rounded-xl p-4 sm:p-6 shadow-lg border-2 border-slate-200">
                        <label className="block text-sm font-medium text-slate-700 mb-3">Costo de Envío:</label>
                        
                        <div className="flex items-center gap-2 sm:gap-4">
                            {/* <Button
                                type="button"
                                variant="outline"
                                size="lg"
                                onClick={() => setNewCostoEnvioStr(Math.max(0, newCostoEnvio - 100).toString())}
                                className="w-10 h-10 sm:w-12 sm:h-12 rounded-full text-lg sm:text-xl font-bold bg-slate-500 text-white hover:bg-slate-600 flex-shrink-0"
                            >
                                -
                            </Button> */}
                            <div className="flex-1 relative">
                                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-2xl sm:text-3xl font-bold text-slate-700">$</span>
                                <Input
                                    type="number"
                                    value={newCostoEnvioStr}
                                    onChange={(e) => {
                                        const value = e.target.value;
                                        if (value === "" || /^\d+$/.test(value)) {
                                            setNewCostoEnvioStr(value);
                                        }
                                    }}
                                    onWheel={(e) => e.currentTarget.blur()}
                                    placeholder="0"
                                    className="h-14 sm:h-16 text-center text-2xl sm:text-4xl font-bold text-cyan-600 border-2 border-cyan-300 placeholder:text-cyan-400 pl-10"
                                    min="0"
                                />
                            </div>
                            {/* <Button
                                type="button"
                                variant="outline"
                                size="lg"
                                onClick={() => setNewCostoEnvioStr((newCostoEnvio + 100).toString())}
                                className="w-10 h-10 sm:w-12 sm:h-12 rounded-full text-lg sm:text-xl font-bold bg-cyan-600 text-white hover:bg-cyan-700 flex-shrink-0"
                            >
                                +
                            </Button> */}
                        </div>

                        <div className="flex gap-2 mt-4 flex-wrap justify-center">
                            <button
                                type="button"
                                onClick={() => setNewCostoEnvioStr('2000')}
                                className="px-4 py-2 text-sm font-semibold bg-slate-200 hover:bg-slate-300 rounded-lg transition-colors"
                            >
                                $2000
                            </button>
                            <button
                                type="button"
                                onClick={() => setNewCostoEnvioStr('2500')}
                                className="px-4 py-2 text-sm font-semibold bg-slate-200 hover:bg-slate-300 rounded-lg transition-colors"
                            >
                                $2500
                            </button>
                            <button
                                type="button"
                                onClick={() => setNewCostoEnvioStr('3000')}
                                className="px-4 py-2 text-sm font-semibold bg-slate-200 hover:bg-slate-300 rounded-lg transition-colors"
                            >
                                $3000
                            </button>
                        </div>
                    </div>
                </div>

                <div className="flex gap-3 justify-end mt-6">
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                        className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                        Cancelar
                    </Button>
                    <Button
                        type="button"                        
                        onClick={handleSave}
                        className="px-4 py-2 bg-cyan-600 text-white rounded-md hover:bg-cyan-700 transition-colors font-semibold"
                        disabled={newCostoEnvio === costoEnvio}
                    >
                        Guardar
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}