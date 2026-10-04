"""A real desktop window used to qualify the framework-independent GUI path."""
def increment(value):
    return value + 1


if __name__ == '__main__':
    import faulthandler
    faulthandler.dump_traceback_later(20)
    print('Creating native application window',flush=True)
    import tkinter as tk
    window = tk.Tk()
    print('Native window constructed',flush=True)
    window.title('StackPilot desktop qualification')
    window.geometry('640x360')
    window.configure(background='#f5f7f8')
    count = tk.IntVar(value=0)
    tk.Label(window,text='Real desktop application',font=('DejaVu Sans',22),background='#f5f7f8').pack(pady=30)
    status = tk.Label(window,text='Clicks: 0',font=('DejaVu Sans',18),background='#f5f7f8')
    status.pack(pady=15)
    def click():
        count.set(increment(count.get()))
        status.configure(text=f'Clicks: {count.get()}')
    tk.Button(window,text='Increment',command=click,font=('DejaVu Sans',16),padx=30,pady=12).pack()
    window.after(100,faulthandler.cancel_dump_traceback_later)
    print('Entering native event loop',flush=True)
    window.mainloop()
